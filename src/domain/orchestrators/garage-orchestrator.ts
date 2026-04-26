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

export class GarageOrchestrator {
  private currentState: DoorState;
  private targetState: DoorTarget;
  private lastStable: 'open' | 'closed';
  private settleHandle: TimerHandle | null = null;
  private autoCloseHandle: TimerHandle | null = null;
  private autoCloseSettleHandle: TimerHandle | null = null;
  private pollHandle: TimerHandle | null = null;
  private stopped = false;

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
    if (this.cfg.stateCommand && this.cfg.stateParser && this.cfg.timing.statePollIntervalMs > 0) {
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }
  }

  stop(): void {
    this.stopped = true;
    this.cancelAllTimers();
  }

  async setTarget(target: DoorTarget): Promise<void> {
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
    try {
      await this.cfg.runner.run(this.cfg.openCommand);
    } catch (err) {
      this.logCommandFailure('open', err);
      this.rollbackToLastStable();
      throw err;
    }
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
    try {
      await this.cfg.runner.run(this.cfg.closeCommand);
    } catch (err) {
      this.logCommandFailure('close', err);
      this.rollbackToLastStable();
      throw err;
    }
    this.scheduleSettle(DoorState.Closed, this.cfg.timing.closeTravelTimeMs, () => {
      this.lastStable = 'closed';
    });
  }

  private rollbackToLastStable(): void {
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
    this.settleHandle = this.cfg.clock.setTimeout(() => {
      this.settleHandle = null;
      this.transitionTo(finalState);
      after?.();
    }, travelMs);
  }

  private scheduleAutoClose(): void {
    this.autoCloseHandle = this.cfg.clock.setTimeout(() => {
      this.autoCloseHandle = null;
      if (this.cfg.timing.autoCloseMode === 'execute') {
        // Plugin actively closes the gate. Errors are already logged and rolled
        // back inside requestClose; nothing useful to do with the rejection here.
        void this.requestClose().catch(() => {});
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
        return;
      }
      this.autoCloseSettleHandle = this.cfg.clock.setTimeout(() => {
        this.autoCloseSettleHandle = null;
        this.transitionTo(DoorState.Closed);
        this.lastStable = 'closed';
      }, travel);
    }, this.cfg.timing.autoCloseTimeoutMs);
  }

  private scheduleNextPoll(): void {
    if (this.stopped) {
      return;
    }
    this.pollHandle = this.cfg.clock.setTimeout(() => {
      this.pollHandle = null;
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }, this.cfg.timing.statePollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.cfg.stateCommand || !this.cfg.stateParser) {
      return;
    }
    try {
      const result = await this.cfg.runner.run(this.cfg.stateCommand);
      const parsed = this.cfg.stateParser.parse(result.stdout);
      if (parsed === null) {
        this.cfg.logger.warn('state poll: unrecognised output', { stdout: truncate(result.stdout, 256) });
        return;
      }
      this.reconcile(parsed);
    } catch (err) {
      this.cfg.logger.warn('state poll failed', { reason: (err as Error).message });
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
  }

  private transitionTo(state: DoorState): void {
    if (this.currentState === state) {
      return;
    }
    this.currentState = state;
    this.cfg.onChange(this.currentState, this.targetState);
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
