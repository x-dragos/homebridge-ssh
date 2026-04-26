import type { Clock, TimerHandle } from '../ports/clock.js';
import type { CommandRunner } from '../ports/command-runner.js';
import type { Logger } from '../ports/logger.js';
import type { CommandSpec } from '../command/command-spec.js';
import { CommandRunnerError, CommandRunnerTimeoutError } from '../command/errors.js';
import type { OnOffParser } from '../parsers/on-off-parser.js';

export type SwitchMode = 'stateful' | 'momentary';

export interface SwitchOrchestratorConfig {
  readonly runner: CommandRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly onStateChange: (on: boolean) => void;
  readonly onCommand: CommandSpec;
  readonly offCommand?: CommandSpec | undefined;
  readonly mode: SwitchMode;
  readonly autoResetMs?: number | undefined;
  readonly stateCommand?: CommandSpec | undefined;
  readonly stateParser?: OnOffParser | undefined;
  readonly statePollIntervalMs?: number | undefined;
}

interface PollingConfig {
  readonly command: CommandSpec;
  readonly parser: OnOffParser;
  readonly intervalMs: number;
}

export class SwitchOrchestrator {
  private state = false;
  private autoResetHandle: TimerHandle | null = null;
  private pollHandle: TimerHandle | null = null;
  private stopped = false;
  private readonly polling: PollingConfig | null;

  constructor(private readonly cfg: SwitchOrchestratorConfig) {
    if (cfg.stateCommand && cfg.stateParser && (cfg.statePollIntervalMs ?? 0) > 0) {
      this.polling = {
        command: cfg.stateCommand,
        parser: cfg.stateParser,
        intervalMs: cfg.statePollIntervalMs!,
      };
    } else {
      this.polling = null;
    }
  }

  setInitialState(on: boolean): void {
    this.state = on;
  }

  isOn(): boolean {
    return this.state;
  }

  start(): void {
    if (this.stopped || !this.polling) {
      return;
    }
    void this.pollOnce().finally(() => this.scheduleNextPoll());
  }

  stop(): void {
    this.stopped = true;
    if (this.pollHandle) {
      this.cfg.clock.clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.autoResetHandle) {
      this.cfg.clock.clearTimeout(this.autoResetHandle);
      this.autoResetHandle = null;
    }
  }

  async setOn(on: boolean): Promise<void> {
    if (on) {
      await this.runOn();
      return;
    }
    await this.runOff();
  }

  private async runOn(): Promise<void> {
    const previous = this.state;
    try {
      await this.cfg.runner.run(this.cfg.onCommand);
    } catch (err) {
      this.logCommandFailure('on', err);
      // In momentary mode, ensure HomeKit sees state flip back to false if it had optimistically
      // shown true (spec §6.2: "set On=false immediately and throw").
      if (this.cfg.mode === 'momentary' && previous === true) {
        this.updateState(false);
      }
      throw err;
    }
    this.updateState(true);
    if (this.cfg.mode === 'momentary' && this.cfg.autoResetMs !== undefined) {
      this.scheduleAutoReset(this.cfg.autoResetMs);
    }
  }

  private async runOff(): Promise<void> {
    if (this.cfg.mode === 'momentary') {
      return;
    }
    if (!this.cfg.offCommand) {
      this.updateState(false);
      return;
    }
    try {
      await this.cfg.runner.run(this.cfg.offCommand);
    } catch (err) {
      this.logCommandFailure('off', err);
      throw err;
    }
    this.updateState(false);
  }

  private updateState(on: boolean): void {
    if (this.state === on) {
      return;
    }
    this.state = on;
    this.cfg.onStateChange(on);
  }

  private scheduleAutoReset(ms: number): void {
    if (this.autoResetHandle) {
      this.cfg.clock.clearTimeout(this.autoResetHandle);
    }
    this.autoResetHandle = this.cfg.clock.setTimeout(() => {
      this.autoResetHandle = null;
      this.updateState(false);
    }, ms);
  }

  // Next poll is scheduled from completion (not start) of the previous one,
  // so a stalled SSH connection cannot pile up overlapping state-fetches.
  private scheduleNextPoll(): void {
    if (this.stopped || !this.polling) {
      return;
    }
    this.pollHandle = this.cfg.clock.setTimeout(() => {
      this.pollHandle = null;
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }, this.polling.intervalMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.polling) {
      return;
    }
    try {
      const result = await this.cfg.runner.run(this.polling.command);
      const parsed = this.polling.parser.parse(result.stdout);
      this.updateState(parsed);
    } catch (err) {
      this.logCommandFailure('state', err);
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
