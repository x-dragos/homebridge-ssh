import { beforeEach, describe, expect, it } from 'vitest';
import { GarageOrchestrator } from '../../../src/domain/orchestrators/garage-orchestrator.js';
import { DoorState } from '../../../src/domain/orchestrators/door-state.js';
import { FakeClock } from '../../support/fake-clock.js';
import { FakeCommandRunner, ok, fail } from '../../support/fake-command-runner.js';
import { FakeLogger } from '../../support/fake-logger.js';
import { CommandRunnerConnectError, CommandRunnerTimeoutError } from '../../../src/domain/command/errors.js';
import { GarageStateParser } from '../../../src/domain/parsers/garage-state-parser.js';

describe('GarageOrchestrator — open/close transitions', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;
  let observed: { current: DoorState; target: 'open' | 'closed' }[];

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    observed = [];
  });

  function build(overrides: Partial<ConstructorParameters<typeof GarageOrchestrator>[0]> = {}) {
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
    return new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: (current, target) => observed.push({ current, target }),
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      timing: {
        openTravelTimeMs: 15000,
        closeTravelTimeMs: 15000,
        autoCloseTimeoutMs: 0,
        autoCloseMode: 'execute',
        statePollIntervalMs: 0,
      },
      ...overrides,
    });
  }

  it('open from closed: emits OPENING then OPEN after travel time', async () => {
    const o = build();
    await o.setTarget('open');
    expect(o.current()).toBe(DoorState.Opening);
    expect(observed[0]).toEqual({ current: DoorState.Opening, target: 'open' });
    clock.advance(14999);
    expect(o.current()).toBe(DoorState.Opening);
    clock.advance(1);
    expect(o.current()).toBe(DoorState.Open);
    expect(observed.at(-1)).toEqual({ current: DoorState.Open, target: 'open' });
  });

  it('close from open: emits CLOSING then CLOSED', async () => {
    const o = build();
    await o.setTarget('open');
    clock.advance(15000);
    await o.setTarget('closed');
    expect(o.current()).toBe(DoorState.Closing);
    clock.advance(15000);
    expect(o.current()).toBe(DoorState.Closed);
  });

  it('idempotent: open while opening does not re-run', async () => {
    const o = build();
    await o.setTarget('open');
    await o.setTarget('open');
    expect(runner.invocations.filter((i) => i.command === 'open')).toHaveLength(1);
  });

  it('idempotent: open while open is a no-op', async () => {
    const o = build();
    await o.setTarget('open');
    clock.advance(15000);
    await o.setTarget('open');
    expect(runner.invocations.filter((i) => i.command === 'open')).toHaveLength(1);
  });

  it('zero travel time settles immediately', async () => {
    const o = build({
      timing: {
        openTravelTimeMs: 0,
        closeTravelTimeMs: 0,
        autoCloseTimeoutMs: 0,
        autoCloseMode: 'execute',
        statePollIntervalMs: 0,
      },
    });
    await o.setTarget('open');
    expect(o.current()).toBe(DoorState.Open);
  });

  it('command failure from CLOSED: snaps back to CLOSED', async () => {
    const o = build();
    runner.setDefault('open', fail(new CommandRunnerConnectError('nope')));
    await expect(o.setTarget('open')).rejects.toBeInstanceOf(CommandRunnerConnectError);
    expect(o.current()).toBe(DoorState.Closed);
    expect(o.target()).toBe('closed');
  });

  it('command failure from OPEN: snaps back to OPEN (last-stable-state rollback)', async () => {
    const o = build();
    await o.setTarget('open');
    clock.advance(15000); // settled to OPEN — now stable
    runner.setDefault('close', fail(new CommandRunnerConnectError('nope')));
    await expect(o.setTarget('closed')).rejects.toBeInstanceOf(CommandRunnerConnectError);
    expect(o.current()).toBe(DoorState.Open);
    expect(o.target()).toBe('open');
  });

  it('command failure mid-CLOSING when user retaps open: rolls back to last stable (OPEN)', async () => {
    const o = build();
    await o.setTarget('open');
    clock.advance(15000); // OPEN
    await o.setTarget('closed');
    clock.advance(5000); // mid-CLOSING
    runner.setDefault('open', fail(new CommandRunnerConnectError('nope')));
    await expect(o.setTarget('open')).rejects.toBeInstanceOf(CommandRunnerConnectError);
    expect(o.current()).toBe(DoorState.Open);
    expect(o.target()).toBe('open');
  });
});

describe('GarageOrchestrator — auto-close (simulated mode)', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;
  let states: DoorState[];

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    states = [];
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
  });

  function buildAutoClose() {
    return new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: (s) => states.push(s),
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      timing: {
        openTravelTimeMs: 1000,
        closeTravelTimeMs: 1000,
        autoCloseTimeoutMs: 5000,
        autoCloseMode: 'simulated',
        statePollIntervalMs: 0,
      },
    });
  }

  it('transitions through Closing/Closed without running the close command', async () => {
    const o = buildAutoClose();
    await o.setTarget('open');
    clock.advance(1000);
    expect(o.current()).toBe(DoorState.Open);
    clock.advance(5000);
    expect(o.current()).toBe(DoorState.Closing);
    clock.advance(1000);
    expect(o.current()).toBe(DoorState.Closed);
    expect(runner.invocations.filter((i) => i.command === 'close')).toHaveLength(0);
    expect(states).toContain(DoorState.Closed);
  });

  it('user-driven close cancels pending auto-close', async () => {
    const o = buildAutoClose();
    await o.setTarget('open');
    clock.advance(1000); // OPEN
    clock.advance(2000); // 2s into the 5s auto-close window
    await o.setTarget('closed');
    expect(o.current()).toBe(DoorState.Closing);
    clock.advance(1000); // close travel done
    expect(o.current()).toBe(DoorState.Closed);
    // Advance past where auto-close would have fired
    clock.advance(10000);
    expect(o.current()).toBe(DoorState.Closed);
    expect(runner.invocations.filter((i) => i.command === 'close')).toHaveLength(1);
  });
});

describe('GarageOrchestrator — auto-close (execute mode)', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;
  let states: DoorState[];

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    states = [];
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
  });

  function buildAutoClose() {
    return new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: (s) => states.push(s),
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      timing: {
        openTravelTimeMs: 1000,
        closeTravelTimeMs: 1000,
        autoCloseTimeoutMs: 5000,
        autoCloseMode: 'execute',
        statePollIntervalMs: 0,
      },
    });
  }

  it('runs the close command when the auto-close timer fires', async () => {
    const o = buildAutoClose();
    await o.setTarget('open');
    clock.advance(1000); // OPEN
    expect(runner.invocations.filter((i) => i.command === 'close')).toHaveLength(0);
    clock.advance(5000); // auto-close fires
    // requestClose is invoked from inside the timer callback as `void requestClose()`,
    // and itself awaits runner.run before scheduling the settle. Drain microtasks.
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'close')).toHaveLength(1);
    expect(o.current()).toBe(DoorState.Closing);
    clock.advance(1000);
    expect(o.current()).toBe(DoorState.Closed);
  });
});

describe('GarageOrchestrator — concurrent and mid-motion taps', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
  });

  function build() {
    return new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: () => {},
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      timing: {
        openTravelTimeMs: 10000,
        closeTravelTimeMs: 10000,
        autoCloseTimeoutMs: 0,
        autoCloseMode: 'execute',
        statePollIntervalMs: 0,
      },
    });
  }

  it('close mid-OPENING cancels and starts CLOSING', async () => {
    const o = build();
    await o.setTarget('open');
    clock.advance(5000);
    expect(o.current()).toBe(DoorState.Opening);
    await o.setTarget('closed');
    expect(o.current()).toBe(DoorState.Closing);
    clock.advance(10000);
    expect(o.current()).toBe(DoorState.Closed);
  });

  it('open mid-CLOSING cancels and starts OPENING', async () => {
    const o = build();
    await o.setTarget('open');
    clock.advance(10000); // OPEN
    await o.setTarget('closed');
    clock.advance(5000); // mid-CLOSING
    expect(o.current()).toBe(DoorState.Closing);
    await o.setTarget('open');
    expect(o.current()).toBe(DoorState.Opening);
    clock.advance(10000);
    expect(o.current()).toBe(DoorState.Open);
  });
});

describe('GarageOrchestrator — state poll reconciliation', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;
  let states: DoorState[];

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    states = [];
  });

  function buildWithPoll(
    stateMapping = {
      open: { match: 'OPEN', mode: 'exact' as const },
      closed: { match: 'CLOSED', mode: 'exact' as const },
      opening: { match: 'OPENING', mode: 'exact' as const },
      closing: { match: 'CLOSING', mode: 'exact' as const },
    },
  ) {
    return new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: (s) => states.push(s),
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      stateCommand: { command: 'state', timeoutMs: 1000 },
      stateParser: new GarageStateParser(stateMapping),
      timing: {
        openTravelTimeMs: 10000,
        closeTravelTimeMs: 10000,
        autoCloseTimeoutMs: 0,
        autoCloseMode: 'execute',
        statePollIntervalMs: 30000,
      },
      initialState: DoorState.Closed,
    });
  }

  it('snaps to polled state when it differs', async () => {
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
    runner.setDefault('state', ok({ stdout: 'OPEN\n' }));
    const o = buildWithPoll();
    o.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(o.current()).toBe(DoorState.Open);
    expect(logger.entries.some((e) => e.message.includes('state drift corrected'))).toBe(true);
    o.stop();
  });

  it('logs warn and keeps state when poll command fails', async () => {
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
    runner.setDefault('state', fail(new CommandRunnerTimeoutError(1000)));
    const o = buildWithPoll();
    o.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(o.current()).toBe(DoorState.Closed); // unchanged
    expect(logger.entries.some((e) => e.level === 'warn' && e.message.includes('state poll failed'))).toBe(true);
    o.stop();
  });

  it('logs warn when poll output is unrecognised, keeps state', async () => {
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
    runner.setDefault('state', ok({ stdout: 'GARBAGE\n' }));
    const o = buildWithPoll();
    o.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(o.current()).toBe(DoorState.Closed);
    expect(logger.entries.some((e) => e.level === 'warn' && e.message.includes('unrecognised output'))).toBe(true);
    o.stop();
  });

  it('exponentially backs off consecutive poll failures and resets on success', async () => {
    // The plugin used to spam the log at the configured cadence whenever the
    // SSH connection was poisoned (eg. MaxSessions exhausted on the remote).
    // Backoff caps the noise: each failure doubles the wait, with a hard cap.
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
    runner.setDefault('state', fail(new CommandRunnerTimeoutError(1000)));

    const o = new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: (s) => states.push(s),
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      stateCommand: { command: 'state', timeoutMs: 1000 },
      stateParser: new GarageStateParser({
        open: { match: 'OPEN', mode: 'exact' },
        closed: { match: 'CLOSED', mode: 'exact' },
      }),
      timing: {
        openTravelTimeMs: 10000,
        closeTravelTimeMs: 10000,
        autoCloseTimeoutMs: 0,
        autoCloseMode: 'execute',
        statePollIntervalMs: 1000,
      },
      initialState: DoorState.Closed,
    });
    o.start();
    await new Promise((r) => setImmediate(r));
    const polls0 = runner.invocations.filter((i) => i.command === 'state').length;

    // After the 1st failure backoff = base = 1000ms. Advance 999ms → no poll.
    clock.advance(999);
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'state').length).toBe(polls0);
    // 1ms more → poll fires, fails. Backoff doubles to 2000ms.
    clock.advance(1);
    await new Promise((r) => setImmediate(r));
    const polls1 = runner.invocations.filter((i) => i.command === 'state').length;
    expect(polls1).toBe(polls0 + 1);

    // After 2nd failure: 1999ms is not enough.
    clock.advance(1999);
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'state').length).toBe(polls1);
    clock.advance(1);
    await new Promise((r) => setImmediate(r));
    const polls2 = runner.invocations.filter((i) => i.command === 'state').length;
    expect(polls2).toBe(polls1 + 1);

    // 3rd failure: backoff at 4000ms.
    clock.advance(3999);
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'state').length).toBe(polls2);
    clock.advance(1);
    await new Promise((r) => setImmediate(r));
    const polls3 = runner.invocations.filter((i) => i.command === 'state').length;
    expect(polls3).toBe(polls2 + 1);

    // Now make state succeed: backoff should reset to base on the next success.
    runner.setDefault('state', ok({ stdout: 'CLOSED\n' }));
    // Backoff is at 8000ms after 3rd failure. Advance to fire the next poll
    // (which will succeed and reset the counter).
    clock.advance(8000);
    await new Promise((r) => setImmediate(r));
    const pollsAfterSuccess = runner.invocations.filter((i) => i.command === 'state').length;
    expect(pollsAfterSuccess).toBe(polls3 + 1);

    // Reset confirmed: next failure should wait base (1000ms) again, not 16000ms.
    runner.setDefault('state', fail(new CommandRunnerTimeoutError(1000)));
    clock.advance(1000);
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'state').length).toBe(pollsAfterSuccess + 1);

    o.stop();
  });

  it('caps backoff at 60 seconds regardless of how many failures accumulate', async () => {
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
    runner.setDefault('state', fail(new CommandRunnerTimeoutError(1000)));

    const o = new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: (s) => states.push(s),
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      stateCommand: { command: 'state', timeoutMs: 1000 },
      stateParser: new GarageStateParser({
        open: { match: 'OPEN', mode: 'exact' },
        closed: { match: 'CLOSED', mode: 'exact' },
      }),
      timing: {
        openTravelTimeMs: 10000,
        closeTravelTimeMs: 10000,
        autoCloseTimeoutMs: 0,
        autoCloseMode: 'execute',
        statePollIntervalMs: 1000,
      },
      initialState: DoorState.Closed,
    });
    o.start();
    await new Promise((r) => setImmediate(r));

    // Burn through enough failures to push backoff past the cap.
    for (let i = 0; i < 8; i++) {
      clock.advance(60_000);
      await new Promise((r) => setImmediate(r));
    }
    const pollsAtCap = runner.invocations.filter((i) => i.command === 'state').length;

    // After cap, the next poll must arrive within 60s (not 120s, 240s, etc.).
    clock.advance(59_999);
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'state').length).toBe(pollsAtCap);
    clock.advance(1);
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'state').length).toBe(pollsAtCap + 1);

    o.stop();
  });
});

describe('GarageOrchestrator — transient-state fast polling', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
    runner.setDefault('state', ok({ stdout: 'CLOSED\n' }));
  });

  function buildFastPoll() {
    return new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: () => {},
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      stateCommand: { command: 'state', timeoutMs: 1000 },
      stateParser: new GarageStateParser({
        open: { match: 'OPEN', mode: 'exact' },
        closed: { match: 'CLOSED', mode: 'exact' },
        opening: { match: 'OPENING', mode: 'exact' },
        closing: { match: 'CLOSING', mode: 'exact' },
      }),
      timing: {
        openTravelTimeMs: 10000,
        closeTravelTimeMs: 10000,
        autoCloseTimeoutMs: 0,
        autoCloseMode: 'execute',
        statePollIntervalMs: 30000,
        transientPollIntervalMs: 1000,
        // Disable the post-command grace so this test exercises the cadence in
        // isolation; the post-command delay has its own dedicated test below.
        postCommandPollDelayMs: 0,
      },
      initialState: DoorState.Closed,
    });
  }

  it('uses transientPollIntervalMs while Opening, falls back to statePollIntervalMs when Open', async () => {
    const o = buildFastPoll();
    o.start();
    await new Promise((r) => setImmediate(r));
    const stateInvocationsBefore = runner.invocations.filter((i) => i.command === 'state').length;

    // Make the state command agree with the simulated motion so polls do not drift us.
    runner.setDefault('state', ok({ stdout: 'OPENING\n' }));

    await o.setTarget('open');
    expect(o.current()).toBe(DoorState.Opening);

    // While Opening, fast poll fires every second. Advance 3s; expect ~3 polls.
    clock.advance(1000);
    await new Promise((r) => setImmediate(r));
    clock.advance(1000);
    await new Promise((r) => setImmediate(r));
    clock.advance(1000);
    await new Promise((r) => setImmediate(r));
    const stateDuringTransient = runner.invocations.filter((i) => i.command === 'state').length;
    expect(stateDuringTransient - stateInvocationsBefore).toBeGreaterThanOrEqual(3);

    // Settle to Open at 10s total (we already advanced 3000ms; advance the rest).
    runner.setDefault('state', ok({ stdout: 'OPEN\n' }));
    clock.advance(7000);
    await new Promise((r) => setImmediate(r));
    expect(o.current()).toBe(DoorState.Open);
    const stateAtOpen = runner.invocations.filter((i) => i.command === 'state').length;

    // While Open, advance 5s (less than statePollIntervalMs=30s). No new polls expected.
    clock.advance(5000);
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'state').length).toBe(stateAtOpen);

    o.stop();
  });

  it('postCommandPollDelayMs delays the first transient poll after a command runs', async () => {
    const o = new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: () => {},
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      stateCommand: { command: 'state', timeoutMs: 1000 },
      stateParser: new GarageStateParser({
        open: { match: 'OPEN', mode: 'exact' },
        closed: { match: 'CLOSED', mode: 'exact' },
      }),
      timing: {
        openTravelTimeMs: 20000,
        closeTravelTimeMs: 20000,
        autoCloseTimeoutMs: 0,
        autoCloseMode: 'execute',
        statePollIntervalMs: 30000,
        transientPollIntervalMs: 1000,
        postCommandPollDelayMs: 5000,
      },
      initialState: DoorState.Closed,
    });
    runner.setDefault('state', ok({ stdout: 'CLOSED\n' }));
    o.start();
    await new Promise((r) => setImmediate(r));
    const stateBefore = runner.invocations.filter((i) => i.command === 'state').length;

    await o.setTarget('open');
    expect(o.current()).toBe(DoorState.Opening);

    // Even though transientPollIntervalMs is 1000ms, no poll fires within the first
    // 4 seconds because the 5-second post-command grace defers it.
    clock.advance(4000);
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'state').length).toBe(stateBefore);

    // Past the 5-second grace, the poll fires.
    clock.advance(1500);
    await new Promise((r) => setImmediate(r));
    expect(runner.invocations.filter((i) => i.command === 'state').length).toBeGreaterThan(stateBefore);

    o.stop();
  });
});

describe('GarageOrchestrator — auto-close watchdog', () => {
  let runner: FakeCommandRunner;
  let clock: FakeClock;
  let logger: FakeLogger;

  beforeEach(() => {
    runner = new FakeCommandRunner();
    clock = new FakeClock();
    logger = new FakeLogger();
    runner.setDefault('open', ok());
    runner.setDefault('close', ok());
  });

  function buildSimulatedAutoClose() {
    return new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: () => {},
      openCommand: { command: 'open', timeoutMs: 1000 },
      closeCommand: { command: 'close', timeoutMs: 1000 },
      stateCommand: { command: 'state', timeoutMs: 1000 },
      stateParser: new GarageStateParser({
        open: { match: 'OPEN', mode: 'exact' },
        closed: { match: 'CLOSED', mode: 'exact' },
        opening: { match: 'OPENING', mode: 'exact' },
        closing: { match: 'CLOSING', mode: 'exact' },
      }),
      timing: {
        openTravelTimeMs: 1000,
        closeTravelTimeMs: 2000,
        autoCloseTimeoutMs: 5000,
        autoCloseMode: 'simulated',
        statePollIntervalMs: 30000,
        transientPollIntervalMs: 1000,
      },
      initialState: DoorState.Closed,
    });
  }

  it('fires close command if state poll reports Open after auto-close window elapsed (simulated mode)', async () => {
    runner.setDefault('state', ok({ stdout: 'CLOSED\n' }));
    const o = buildSimulatedAutoClose();
    o.start();
    await new Promise((r) => setImmediate(r));

    // Simulate a broken gate: regardless of plugin state, the gate reports OPEN once
    // we've opened it. This stresses the watchdog: hardware never actually closed.
    runner.setDefault('state', ok({ stdout: 'OPENING\n' }));
    await o.setTarget('open');

    runner.setDefault('state', ok({ stdout: 'OPEN\n' }));
    clock.advance(1000); // openTravelTimeMs reached → settled to Open
    await new Promise((r) => setImmediate(r));
    expect(o.current()).toBe(DoorState.Open);
    const closesBeforeWatchdog = runner.invocations.filter((i) => i.command === 'close').length;

    // Auto-close fires at t=1+5=6s. Plugin (simulated) transitions to Closing.
    // Watchdog poll fires at t=6+closeTravelTimeMs(2)=8s — by then elapsed=2s ≥ 2s,
    // gate is still Open per poll, so the watchdog must run the close command.
    clock.advance(7000); // now at t=8000
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const closesAfterWatchdog = runner.invocations.filter((i) => i.command === 'close').length;
    expect(closesAfterWatchdog).toBeGreaterThan(closesBeforeWatchdog);
    expect(logger.entries.some((e) => e.message.includes('auto-close watchdog'))).toBe(true);

    o.stop();
  });
});
