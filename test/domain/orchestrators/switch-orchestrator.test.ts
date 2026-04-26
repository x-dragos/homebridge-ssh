import { beforeEach, describe, expect, it } from 'vitest';
import { SwitchOrchestrator } from '../../../src/domain/orchestrators/switch-orchestrator.js';
import { FakeClock } from '../../support/fake-clock.js';
import { FakeCommandRunner, ok, fail } from '../../support/fake-command-runner.js';
import { FakeLogger } from '../../support/fake-logger.js';
import { CommandRunnerConnectError, CommandRunnerTimeoutError } from '../../../src/domain/command/errors.js';
import { OnOffParser } from '../../../src/domain/parsers/on-off-parser.js';

describe('SwitchOrchestrator — stateful mode', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;
  let stateChanges: boolean[];

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    stateChanges = [];
  });

  function build(overrides?: Partial<ConstructorParameters<typeof SwitchOrchestrator>[0]>) {
    return new SwitchOrchestrator({
      runner,
      clock,
      logger,
      onStateChange: (v) => stateChanges.push(v),
      onCommand: { command: 'on', timeoutMs: 1000 },
      offCommand: { command: 'off', timeoutMs: 1000 },
      mode: 'stateful',
      ...overrides,
    });
  }

  it('runs the on command and updates state to true', async () => {
    runner.setDefault('on', ok());
    const o = build();
    await o.setOn(true);
    expect(stateChanges).toEqual([true]);
    expect(runner.invocations.map((i) => i.command)).toEqual(['on']);
  });

  it('runs the off command and updates state to false', async () => {
    runner.setDefault('off', ok());
    const o = build();
    o.setInitialState(true);
    await o.setOn(false);
    expect(stateChanges).toEqual([false]);
    expect(runner.invocations.map((i) => i.command)).toEqual(['off']);
  });

  it('throws and does not update state on command failure', async () => {
    runner.setDefault('on', fail(new CommandRunnerConnectError('boom')));
    const o = build();
    await expect(o.setOn(true)).rejects.toBeInstanceOf(CommandRunnerConnectError);
    expect(stateChanges).toEqual([]);
  });

  it('logs warning on timeout and rethrows', async () => {
    runner.setDefault('on', fail(new CommandRunnerTimeoutError(1000)));
    const o = build();
    await expect(o.setOn(true)).rejects.toBeInstanceOf(CommandRunnerTimeoutError);
    expect(logger.entries.some((e) => e.level === 'warn' && e.message.includes('timed out'))).toBe(true);
  });

  it('treats setOn(false) as state-only flip when no off command', async () => {
    const o = build({ offCommand: undefined });
    o.setInitialState(true);
    await o.setOn(false);
    expect(stateChanges).toEqual([false]);
    expect(runner.invocations).toHaveLength(0);
  });
});

describe('SwitchOrchestrator — momentary mode', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;
  let stateChanges: boolean[];

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    stateChanges = [];
  });

  function build(overrides?: Partial<ConstructorParameters<typeof SwitchOrchestrator>[0]>) {
    return new SwitchOrchestrator({
      runner,
      clock,
      logger,
      onStateChange: (v) => stateChanges.push(v),
      onCommand: { command: 'fire', timeoutMs: 1000 },
      mode: 'momentary',
      autoResetMs: 1000,
      ...overrides,
    });
  }

  it('flips on then auto-resets to off after autoResetMs', async () => {
    runner.setDefault('fire', ok());
    const o = build();
    await o.setOn(true);
    expect(stateChanges).toEqual([true]);
    clock.advance(999);
    expect(stateChanges).toEqual([true]);
    clock.advance(1);
    expect(stateChanges).toEqual([true, false]);
  });

  it('cancels prior auto-reset when triggered again before reset fires', async () => {
    runner.setDefault('fire', ok());
    const o = build();
    await o.setOn(true);
    clock.advance(500);
    await o.setOn(true);
    clock.advance(500);
    expect(stateChanges).toEqual([true]);
    clock.advance(500);
    expect(stateChanges).toEqual([true, false]);
  });

  it('explicit setOn(false) during the auto-reset window is a no-op', async () => {
    runner.setDefault('fire', ok());
    const o = build();
    await o.setOn(true);
    await o.setOn(false);
    expect(runner.invocations.map((i) => i.command)).toEqual(['fire']);
  });

  it('on command failure when previously on: emits state=false and throws', async () => {
    runner.setDefault('fire', fail(new CommandRunnerConnectError('boom')));
    const o = build();
    o.setInitialState(true);
    await expect(o.setOn(true)).rejects.toBeInstanceOf(CommandRunnerConnectError);
    expect(stateChanges).toEqual([false]);
  });

  it('on command failure when previously off: throws without spurious state change', async () => {
    runner.setDefault('fire', fail(new CommandRunnerConnectError('boom')));
    const o = build();
    await expect(o.setOn(true)).rejects.toBeInstanceOf(CommandRunnerConnectError);
    expect(stateChanges).toEqual([]);
  });
});

describe('SwitchOrchestrator — state polling', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;
  let stateChanges: boolean[];

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    stateChanges = [];
  });

  const flushMicrotasks = () => new Promise((r) => setImmediate(r));

  it('polls and pushes change when value differs', async () => {
    runner.setDefault('state', ok({ stdout: 'on\n' }));
    const o = new SwitchOrchestrator({
      runner,
      clock,
      logger,
      onStateChange: (v) => stateChanges.push(v),
      onCommand: { command: 'unused', timeoutMs: 1000 },
      mode: 'stateful',
      stateCommand: { command: 'state', timeoutMs: 1000 },
      stateParser: new OnOffParser({ onValue: 'on', mode: 'exact' }),
      statePollIntervalMs: 5000,
    });
    o.start();
    await flushMicrotasks();
    expect(stateChanges).toEqual([true]);
    runner.setDefault('state', ok({ stdout: 'off\n' }));
    clock.advance(5000);
    await flushMicrotasks();
    expect(stateChanges).toEqual([true, false]);
    o.stop();
  });

  it('logs warning and keeps state when poll command fails', async () => {
    runner.setDefault('state', fail(new CommandRunnerTimeoutError(1000)));
    const o = new SwitchOrchestrator({
      runner,
      clock,
      logger,
      onStateChange: (v) => stateChanges.push(v),
      onCommand: { command: 'unused', timeoutMs: 1000 },
      mode: 'stateful',
      stateCommand: { command: 'state', timeoutMs: 1000 },
      stateParser: new OnOffParser({ onValue: 'on', mode: 'exact' }),
      statePollIntervalMs: 5000,
    });
    o.start();
    await flushMicrotasks();
    expect(stateChanges).toEqual([]);
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);
    o.stop();
  });
});
