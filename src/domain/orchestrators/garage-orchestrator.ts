import type { Clock, TimerHandle } from '../ports/clock.js';
import type { CommandRunner } from '../ports/command-runner.js';
import type { Logger } from '../ports/logger.js';
import type { CommandSpec } from '../command/command-spec.js';
import { CommandRunnerError, CommandRunnerTimeoutError } from '../command/errors.js';
import { DoorState } from './door-state.js';
import type { GarageStateParser } from '../parsers/garage-state-parser.js';

export type DoorTarget = 'open' | 'closed';

export type AutoCloseMode = 'execute' | 'simulated';

export interface GarageTiming {
  readonly openTravelTimeMs: number;
  readonly closeTravelTimeMs: number;
  readonly autoCloseTimeoutMs: number;
  readonly autoCloseMode: AutoCloseMode;
  readonly statePollIntervalMs: number;
  /**
   * Optional fast-poll cadence used while the door is in a transient state (Opening/Closing).
   * 0 = use `statePollIntervalMs` regardless of state. Default in the schema: 1000ms.
   * Lets HomeKit see real progress without spamming SSH while the door is parked.
   */
  readonly transientPollIntervalMs?: number;
  /**
   * Grace period to wait after issuing an open/close command before the next state
   * poll fires. Prevents the poll from racing the remote script: a freshly-issued
   * open hasn't had time to write OPENING to the state file yet, and an early poll
   * would read the previous CLOSED value and incorrectly drift the orchestrator
   * back. 0 = no grace, fall back to the regular cadence. Default: 5000ms.
   */
  readonly postCommandPollDelayMs?: number;
}

export interface GarageOrchestratorConfig {
  readonly runner: CommandRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly onChange: (current: DoorState, target: DoorTarget) => void;
  readonly openCommand: CommandSpec;
  readonly closeCommand: CommandSpec;
  readonly stateCommand?: CommandSpec | undefined;
  readonly stateParser?: GarageStateParser | undefined;
  readonly timing: GarageTiming;
  readonly initialState?: DoorState | undefined;
}

/** Stable states are the ones the door rests in (no motion). Used for failure rollback. */
function stableFromCurrent(state: DoorState): 'open' | 'closed' {
  if (state === DoorState.Open || state === DoorState.Opening) {
    return 'open';
  }
  return 'closed';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

/** Hard cap for the exponential backoff applied to consecutive poll failures. */
const POLL_BACKOFF_MAX_MS = 60_000;

export class GarageOrchestrator {
  private currentState: DoorState;
  private targetState: DoorTarget;
  private lastStable: 'open' | 'closed';
  private settleHandle: TimerHandle | null = null;
  private autoCloseHandle: TimerHandle | null = null;
  private autoCloseSettleHandle: TimerHandle | null = null;
  private pollHandle: TimerHandle | null = null;
  private stopped = false;
  /**
   * Watchdog timestamp: when auto-close fired (in ms since epoch via Clock).
   * The next state poll that observes Open while we expect to be closing falls back
   * to running the close command. Cleared on success (Closed observed) or stop().
   */
  private autoCloseFiredAt: number | null = null;
  /**
   * Count of consecutive state-poll failures (SSH-level, not parse-level).
   * Drives exponential backoff in `nextPollDelayMs`. Reset to 0 on the first
   * successful state command.
   */
  private consecutiveFailures = 0;
  /**
   * Serialises pollOnce. If a poll is already in flight when another is
   * triggered (eg. the auto-close watchdog poll firing while the regular
   * loop is mid-call), the second call is a no-op. Stops parallel polls
   * from piling up against a slow remote and spamming the log on timeout.
   */
  private pollInFlight = false;
  /** Watchdog poll timer (one-shot, scheduled per auto-close cycle). */
  private watchdogPollHandle: TimerHandle | null = null;

  constructor(private readonly cfg: GarageOrchestratorConfig) {
    this.currentState = cfg.initialState ?? DoorState.Closed;
    this.lastStable = stableFromCurrent(this.currentState);
    this.targetState = this.lastStable;
  }

  current(): DoorState {
    return this.currentState;
  }

  target(): DoorTarget {
    return this.targetState;
  }

  start(): void {
    if (this.stopped) {
      return;
    }
    if (!this.cfg.stateCommand || !this.cfg.stateParser) {
      return;
    }
    // Start polling if either cadence is configured. The interval picker will
    // skip the next schedule when the cadence relevant to the current state is 0.
    if (this.cfg.timing.statePollIntervalMs > 0 || (this.cfg.timing.transientPollIntervalMs ?? 0) > 0) {
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }
  }

  stop(): void {
    this.stopped = true;
    this.autoCloseFiredAt = null;
    this.cancelAllTimers();
  }

  async setTarget(target: DoorTarget): Promise<void> {
    // User is taking control; the auto-close watchdog is no longer relevant.
    this.autoCloseFiredAt = null;
    if (target === 'open') {
      return this.requestOpen();
    }
    return this.requestClose();
  }

  private async requestOpen(): Promise<void> {
    if (this.currentState === DoorState.Open || this.currentState === DoorState.Opening) {
      this.targetState = 'open';
      return;
    }
    this.cancelMotionTimers();
    this.targetState = 'open';
    this.transitionTo(DoorState.Opening);
    // Cancel any poll the transition just queued: we're about to issue an
    // SSH command, and a concurrent poll firing during the await would race
    // the remote script writing OPENING. Resumed by deferPollAfterCommand below.
    this.cancelPendingPoll();
    try {
      await this.cfg.runner.run(this.cfg.openCommand);
    } catch (err) {
      this.logCommandFailure('open', err);
      this.rollbackToLastStable();
      throw err;
    }
    this.deferPollAfterCommand();
    this.scheduleSettle(DoorState.Open, this.cfg.timing.openTravelTimeMs, () => {
      this.lastStable = 'open';
      if (this.cfg.timing.autoCloseTimeoutMs > 0) {
        this.scheduleAutoClose();
      }
    });
  }

  private async requestClose(): Promise<void> {
    if (this.currentState === DoorState.Closed || this.currentState === DoorState.Closing) {
      this.targetState = 'closed';
      return;
    }
    this.cancelMotionTimers();
    this.targetState = 'closed';
    this.transitionTo(DoorState.Closing);
    this.cancelPendingPoll();
    try {
      await this.cfg.runner.run(this.cfg.closeCommand);
    } catch (err) {
      this.logCommandFailure('close', err);
      this.rollbackToLastStable();
      throw err;
    }
    this.deferPollAfterCommand();
    this.scheduleSettle(DoorState.Closed, this.cfg.timing.closeTravelTimeMs, () => {
      this.lastStable = 'closed';
    });
  }

  private cancelPendingPoll(): void {
    if (this.pollHandle) {
      this.cfg.clock.clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /**
   * Push the next state poll out by `postCommandPollDelayMs`. Called right after
   * a successful open/close exec so the immediate transient poll cadence doesn't
   * race the remote script writing the new state to its state file.
   */
  private deferPollAfterCommand(): void {
    if (this.stopped) {
      return;
    }
    if (!this.cfg.stateCommand || !this.cfg.stateParser) {
      return;
    }
    const delay = this.cfg.timing.postCommandPollDelayMs ?? 5000;
    if (this.pollHandle) {
      this.cfg.clock.clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    if (delay <= 0) {
      this.scheduleNextPoll();
      return;
    }
    this.pollHandle = this.cfg.clock.setTimeout(() => {
      this.pollHandle = null;
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }, delay);
  }

  private rollbackToLastStable(): void {
    // A failed command also clears the watchdog so we don't enter a retry loop on
    // a permanently broken close path.
    this.autoCloseFiredAt = null;
    this.cancelMotionTimers();
    this.targetState = this.lastStable;
    const settled: DoorState = this.lastStable === 'open' ? DoorState.Open : DoorState.Closed;
    this.transitionTo(settled);
  }

  private scheduleSettle(finalState: DoorState, travelMs: number, after?: () => void): void {
    if (travelMs <= 0) {
      this.transitionTo(finalState);
      after?.();
      return;
    }
    // Cancel any existing settle before assigning a new one. Two requestOpen/
    // requestClose calls can interleave (rapid HomeKit taps) and both reach
    // their scheduleSettle after their cancelMotionTimers ran — without a
    // cancel here the first settle's timer is leaked and fires alongside
    // the new one, causing the door state to oscillate.
    if (this.settleHandle) {
      this.cfg.clock.clearTimeout(this.settleHandle);
      this.settleHandle = null;
    }
    this.settleHandle = this.cfg.clock.setTimeout(() => {
      this.settleHandle = null;
      this.transitionTo(finalState);
      after?.();
    }, travelMs);
  }

  private scheduleAutoClose(): void {
    if (this.autoCloseHandle) {
      this.cfg.clock.clearTimeout(this.autoCloseHandle);
      this.autoCloseHandle = null;
    }
    this.autoCloseHandle = this.cfg.clock.setTimeout(() => {
      this.autoCloseHandle = null;
      this.autoCloseFiredAt = this.cfg.clock.now();
      if (this.cfg.timing.autoCloseMode === 'execute') {
        // Plugin actively closes the gate. Errors are already logged and rolled
        // back inside requestClose; nothing useful to do with the rejection here.
        void this.requestClose().catch(() => {});
        this.scheduleAutoCloseWatchdogPoll();
        return;
      }
      // 'simulated': hardware/remote script handles the physical close — the
      // plugin only mirrors the state transition for HomeKit's benefit.
      this.targetState = 'closed';
      this.transitionTo(DoorState.Closing);
      const travel = this.cfg.timing.closeTravelTimeMs;
      if (travel <= 0) {
        this.transitionTo(DoorState.Closed);
        this.lastStable = 'closed';
      } else {
        if (this.autoCloseSettleHandle) {
          this.cfg.clock.clearTimeout(this.autoCloseSettleHandle);
          this.autoCloseSettleHandle = null;
        }
        this.autoCloseSettleHandle = this.cfg.clock.setTimeout(() => {
          this.autoCloseSettleHandle = null;
          this.transitionTo(DoorState.Closed);
          this.lastStable = 'closed';
        }, travel);
      }
      this.scheduleAutoCloseWatchdogPoll();
    }, this.cfg.timing.autoCloseTimeoutMs);
  }

  /**
   * Force a single state poll once `closeTravelTimeMs` has elapsed since auto-close
   * fired. Composes with the regular poll loop: if polling is already running, this
   * is just one extra check; if polling was disabled, it provides the watchdog signal.
   * The watchdog action (firing close as fallback) lives in `checkAutoCloseWatchdog`.
   */
  private scheduleAutoCloseWatchdogPoll(): void {
    if (!this.cfg.stateCommand || !this.cfg.stateParser) {
      return;
    }
    if (this.watchdogPollHandle) {
      this.cfg.clock.clearTimeout(this.watchdogPollHandle);
      this.watchdogPollHandle = null;
    }
    const delayMs = Math.max(this.cfg.timing.closeTravelTimeMs, 1000);
    this.watchdogPollHandle = this.cfg.clock.setTimeout(() => {
      this.watchdogPollHandle = null;
      if (this.stopped || this.autoCloseFiredAt === null) {
        return;
      }
      void this.pollOnce();
    }, delayMs);
  }

  private pollIntervalForCurrent(): number {
    const transient = this.cfg.timing.transientPollIntervalMs ?? 0;
    const isTransient = this.currentState === DoorState.Opening || this.currentState === DoorState.Closing;
    if (isTransient && transient > 0) {
      return transient;
    }
    return this.cfg.timing.statePollIntervalMs;
  }

  /**
   * Cadence for the *next* poll. While SSH is healthy this matches the
   * configured cadence. After consecutive failures (typically because the
   * persistent SSH connection is poisoned and every exec is failing fast),
   * the delay grows exponentially up to `POLL_BACKOFF_MAX_MS` — capping log
   * noise and giving the connection time to recycle before we retry.
   */
  private nextPollDelayMs(): number {
    const cadence = this.pollIntervalForCurrent();
    if (cadence <= 0) {
      return 0;
    }
    if (this.consecutiveFailures === 0) {
      return cadence;
    }
    // Cap the exponent before doing 2 ** n to avoid Infinity for runaway counts.
    const exp = Math.min(this.consecutiveFailures - 1, 30);
    const backoff = Math.min(cadence * 2 ** exp, POLL_BACKOFF_MAX_MS);
    return Math.max(backoff, cadence);
  }

  private scheduleNextPoll(): void {
    if (this.stopped) {
      return;
    }
    if (!this.cfg.stateCommand || !this.cfg.stateParser) {
      return;
    }
    // Always cancel an existing handle before scheduling. Without this, any
    // path that sets pollHandle while a pollOnce is in flight (eg. user
    // setTarget calling deferPollAfterCommand, or watchdog poll triggering
    // reconcile) leaks the timer it set: the in-flight pollOnce's .finally
    // overwrites this.pollHandle but the prior timer keeps firing on its
    // own, growing the parallel chain count by one each cycle.
    if (this.pollHandle) {
      this.cfg.clock.clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    const interval = this.nextPollDelayMs();
    if (interval <= 0) {
      // No cadence applies to the current state; pause polling until the next transition.
      return;
    }
    this.pollHandle = this.cfg.clock.setTimeout(() => {
      this.pollHandle = null;
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }, interval);
  }

  /** Invalidates any pending poll and (re)schedules one with the cadence for the current state. */
  private rescheduleNextPoll(): void {
    if (this.stopped) {
      return;
    }
    if (this.pollHandle) {
      this.cfg.clock.clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    this.scheduleNextPoll();
  }

  private async pollOnce(): Promise<void> {
    if (!this.cfg.stateCommand || !this.cfg.stateParser) {
      return;
    }
    // Defense-in-depth against any code path that double-fires pollOnce.
    // The scheduleNextPoll cancel-before-schedule guard prevents the main
    // chain from leaking, but watchdog polls and future paths could still
    // overlap; a slow remote plus 4s timeouts would amplify noise quickly.
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const result = await this.cfg.runner.run(this.cfg.stateCommand);
      // SSH succeeded — reset the backoff counter even if parsing fails below.
      // A parse miss is a different problem class (script output drifted) and
      // shouldn't keep the connection in slow-poll mode.
      this.consecutiveFailures = 0;
      const parsed = this.cfg.stateParser.parse(result.stdout);
      if (parsed === null) {
        this.cfg.logger.warn('state poll: unrecognised output', { stdout: truncate(result.stdout, 256) });
        return;
      }
      this.reconcile(parsed);
      this.checkAutoCloseWatchdog(parsed);
    } catch (err) {
      this.consecutiveFailures += 1;
      this.cfg.logger.warn('state poll failed', {
        reason: (err as Error).message,
        consecutiveFailures: this.consecutiveFailures,
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Auto-close watchdog: if auto-close fired and the gate is observed to still be
   * Open after enough time has elapsed for the close to have completed, run the
   * close command as fallback. Works in both `execute` and `simulated` modes.
   */
  private checkAutoCloseWatchdog(parsed: DoorState): void {
    if (this.autoCloseFiredAt === null) {
      return;
    }
    if (parsed === DoorState.Closed) {
      // Gate is confirmed closed. Watchdog satisfied.
      this.autoCloseFiredAt = null;
      return;
    }
    if (parsed === DoorState.Closing || parsed === DoorState.Opening) {
      // Still in motion — keep waiting.
      return;
    }
    const elapsed = this.cfg.clock.now() - this.autoCloseFiredAt;
    if (parsed === DoorState.Open && elapsed >= this.cfg.timing.closeTravelTimeMs) {
      this.cfg.logger.warn('auto-close watchdog: gate still open after timeout, firing close command', {
        elapsedMs: elapsed,
      });
      this.autoCloseFiredAt = null;
      void this.requestClose().catch(() => {});
    }
  }

  private reconcile(parsed: DoorState): void {
    if (parsed === this.currentState) {
      return;
    }
    this.cfg.logger.info('state drift corrected', { from: this.currentState, to: parsed });
    this.cancelMotionTimers();
    this.currentState = parsed;
    this.targetState = parsed === DoorState.Open || parsed === DoorState.Opening ? 'open' : 'closed';
    if (parsed === DoorState.Open || parsed === DoorState.Closed) {
      this.lastStable = parsed === DoorState.Open ? 'open' : 'closed';
    }
    this.cfg.onChange(this.currentState, this.targetState);
    this.rescheduleNextPoll();
  }

  private transitionTo(state: DoorState): void {
    if (this.currentState === state) {
      return;
    }
    this.currentState = state;
    this.cfg.onChange(this.currentState, this.targetState);
    // Cadence depends on whether we just entered/left a transient state.
    this.rescheduleNextPoll();
  }

  private cancelMotionTimers(): void {
    if (this.settleHandle) {
      this.cfg.clock.clearTimeout(this.settleHandle);
      this.settleHandle = null;
    }
    if (this.autoCloseHandle) {
      this.cfg.clock.clearTimeout(this.autoCloseHandle);
      this.autoCloseHandle = null;
    }
    if (this.autoCloseSettleHandle) {
      this.cfg.clock.clearTimeout(this.autoCloseSettleHandle);
      this.autoCloseSettleHandle = null;
    }
  }

  private cancelAllTimers(): void {
    this.cancelMotionTimers();
    if (this.pollHandle) {
      this.cfg.clock.clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.watchdogPollHandle) {
      this.cfg.clock.clearTimeout(this.watchdogPollHandle);
      this.watchdogPollHandle = null;
    }
  }

  private logCommandFailure(label: string, err: unknown): void {
    if (err instanceof CommandRunnerTimeoutError) {
      this.cfg.logger.warn(`${label} command timed out`, { timeoutMs: err.timeoutMs });
      return;
    }
    if (err instanceof CommandRunnerError) {
      this.cfg.logger.warn(`${label} command failed`, { reason: err.message });
      return;
    }
    this.cfg.logger.error(`${label} command failed unexpectedly`, err);
  }
}
