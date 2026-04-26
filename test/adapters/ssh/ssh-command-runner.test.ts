import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshCommandRunner } from '../../../src/adapters/ssh/ssh-command-runner.js';
import {
  CommandRunnerConnectError,
  CommandRunnerNonZeroExitError,
  CommandRunnerTimeoutError,
} from '../../../src/domain/command/errors.js';
import { FakeLogger } from '../../support/fake-logger.js';

class FakeChannel extends EventEmitter {
  public readonly stderr = new EventEmitter();
  emitData(data: string) {
    this.emit('data', Buffer.from(data));
  }
  emitStderr(data: string) {
    this.stderr.emit('data', Buffer.from(data));
  }
  finish(exitCode: number) {
    this.emit('exit', exitCode);
    this.emit('close');
  }
}

class FakeClient extends EventEmitter {
  public connectCalls: any[] = [];
  public ended = false;
  private nextChannel: FakeChannel | null = null;
  private nextExecError: Error | null = null;

  connect(opts: any) {
    this.connectCalls.push(opts);
    return this;
  }
  end() {
    this.ended = true;
    setImmediate(() => this.emit('close'));
  }
  exec(_cmd: string, cb: (err: Error | undefined, channel?: FakeChannel) => void) {
    if (this.nextExecError) {
      const err = this.nextExecError;
      this.nextExecError = null;
      setImmediate(() => cb(err));
      return;
    }
    const channel = this.nextChannel ?? new FakeChannel();
    this.nextChannel = null;
    setImmediate(() => cb(undefined, channel));
  }
  prepareChannel(channel: FakeChannel) {
    this.nextChannel = channel;
  }
  triggerReady() {
    this.emit('ready');
  }
  triggerError(err: Error) {
    this.emit('error', err);
  }
}

describe('SshCommandRunner', () => {
  let client: FakeClient;
  let logger: FakeLogger;

  beforeEach(() => {
    client = new FakeClient();
    logger = new FakeLogger();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function build(overrides: Partial<{ idleDisconnectMs: number }> = {}) {
    return new SshCommandRunner({
      logger,
      clientFactory: () => client as never,
      sshConfig: {
        host: '192.0.2.1',
        port: 22,
        user: 'pi',
        auth: { method: 'agent' },
        connectTimeoutMs: 5000,
        keepaliveIntervalMs: 0,
        idleDisconnectMs: 0,
        ...overrides,
      },
    });
  }

  it('lazily connects and resolves connect() on ready event', async () => {
    const runner = build();
    const promise = runner.connect();
    setImmediate(() => client.triggerReady());
    await vi.runAllTimersAsync();
    await promise;
    expect(client.connectCalls).toHaveLength(1);
    expect(client.connectCalls[0].host).toBe('192.0.2.1');
  });

  it('connect() rejects with CommandRunnerConnectError on error before ready', async () => {
    const runner = build();
    const promise = runner.connect();
    const assertion = expect(promise).rejects.toBeInstanceOf(CommandRunnerConnectError);
    setImmediate(() => client.triggerError(new Error('ECONNREFUSED')));
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('connect() rejects with CommandRunnerConnectError on connectTimeoutMs', async () => {
    const runner = build();
    const promise = runner.connect();
    vi.advanceTimersByTime(5000);
    await expect(promise).rejects.toBeInstanceOf(CommandRunnerConnectError);
  });

  it('run() returns stdout, stderr, exitCode, durationMs', async () => {
    const runner = build();
    const channel = new FakeChannel();
    client.prepareChannel(channel);
    const connectPromise = runner.connect();
    setImmediate(() => client.triggerReady());
    await vi.runAllTimersAsync();
    await connectPromise;

    const runPromise = runner.run({ command: 'echo hi', timeoutMs: 1000 });
    // Drain run()'s `await this.connect()` microtask hop and the exec setImmediate so the
    // channel listeners are attached before we emit. Idle is disabled here, so no risk of
    // crossing an idle window.
    await vi.advanceTimersByTimeAsync(0);
    channel.emitData('hi\n');
    channel.emitStderr('warn\n');
    channel.finish(0);
    const result = await runPromise;
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toBe('warn\n');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('debug-logs command + exit + duration + truncated stdout/stderr after success', async () => {
    const runner = build();
    const channel = new FakeChannel();
    client.prepareChannel(channel);
    const connectPromise = runner.connect();
    setImmediate(() => client.triggerReady());
    await vi.runAllTimersAsync();
    await connectPromise;

    const big = 'x'.repeat(1000);
    const runPromise = runner.run({ command: 'cat /file', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0); // drain await this.connect() hop + exec setImmediate
    channel.emitData(big);
    channel.finish(0);
    await runPromise;

    const debug = logger.entries.find((e) => e.level === 'debug' && e.message.includes('exec complete'));
    expect(debug).toBeDefined();
    expect(String(debug!.fields.stdout)).toHaveLength(515); // 512 + '...'
  });

  it('run() throws CommandRunnerNonZeroExitError when exit is not expected', async () => {
    const runner = build();
    const channel = new FakeChannel();
    client.prepareChannel(channel);
    const connectPromise = runner.connect();
    setImmediate(() => client.triggerReady());
    await vi.runAllTimersAsync();
    await connectPromise;

    const runPromise = runner.run({ command: 'false', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0); // drain await this.connect() hop + exec setImmediate
    channel.emitStderr('nope');
    channel.finish(1);
    await expect(runPromise).rejects.toBeInstanceOf(CommandRunnerNonZeroExitError);
  });

  it('run() rejects with CommandRunnerTimeoutError when timeoutMs elapses', async () => {
    const runner = build();
    const channel = new FakeChannel();
    client.prepareChannel(channel);
    const connectPromise = runner.connect();
    setImmediate(() => client.triggerReady());
    await vi.runAllTimersAsync();
    await connectPromise;

    const runPromise = runner.run({ command: 'sleep 10', timeoutMs: 100 });
    const assertion = expect(runPromise).rejects.toBeInstanceOf(CommandRunnerTimeoutError);
    await vi.advanceTimersByTimeAsync(100); // async drain so the run() continuation registers its setTimeout before we advance
    await assertion;
  });

  it('emits onDisconnect listeners when client closes unexpectedly', async () => {
    const runner = build();
    const reasons: Error[] = [];
    runner.onDisconnect((r) => reasons.push(r));
    const connectPromise = runner.connect();
    setImmediate(() => client.triggerReady());
    await vi.runAllTimersAsync();
    await connectPromise;

    client.emit('close');
    expect(reasons).toHaveLength(1);
  });

  it('next run() lazily reconnects after a close', async () => {
    const runner = build();
    const firstChannel = new FakeChannel();
    client.prepareChannel(firstChannel);

    const p1 = runner.connect();
    setImmediate(() => client.triggerReady());
    await vi.runAllTimersAsync();
    await p1;

    client.emit('close');

    const secondChannel = new FakeChannel();
    client.prepareChannel(secondChannel);
    const p2 = runner.run({ command: 'echo again', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0); // drain run()'s connect() entry so openClient attaches listeners
    client.triggerReady();
    await vi.advanceTimersByTimeAsync(0); // drain post-connect microtask + exec setImmediate
    secondChannel.emitData('again\n');
    secondChannel.finish(0);
    const result = await p2;
    expect(result.stdout).toBe('again\n');
    expect(client.connectCalls.length).toBeGreaterThanOrEqual(2);
  });

  describe('idle disconnect', () => {
    // These tests use synchronous `triggerReady()` instead of the `setImmediate(() => triggerReady())`
    // pattern used elsewhere — that pattern requires `vi.runAllTimersAsync()` to drain the immediate,
    // but `runAllTimersAsync` would also fire the future idle timer (defeating the test). Synchronous
    // triggers work here because the runner attaches its `ready`/`error` listeners before returning
    // from `connect()`, so the event lands on the listener.

    it('default idleDisconnectMs=0 never disconnects after connect', async () => {
      const runner = build();
      const cp = runner.connect();
      client.triggerReady();
      await cp;

      vi.advanceTimersByTime(60_000_000); // 16+ hours
      expect(client.ended).toBe(false);
    });

    it('disconnects after idleDisconnectMs of inactivity', async () => {
      const runner = build({ idleDisconnectMs: 30_000 });
      const cp = runner.connect();
      client.triggerReady();
      await cp;

      vi.advanceTimersByTime(29_999);
      expect(client.ended).toBe(false);
      vi.advanceTimersByTime(1);
      expect(client.ended).toBe(true);
    });

    it('run() resets the idle timer; disconnect happens after idle window from last command', async () => {
      const runner = build({ idleDisconnectMs: 30_000 });
      const channel = new FakeChannel();
      client.prepareChannel(channel);
      const cp = runner.connect();
      client.triggerReady();
      await cp;

      vi.advanceTimersByTime(20_000); // 20s into idle window

      const rp = runner.run({ command: 'echo', timeoutMs: 1000 });
      // Drain the synchronous exec callback's setImmediate without crossing the idle window.
      await vi.advanceTimersByTimeAsync(0);
      channel.emitData('hi\n');
      channel.finish(0);
      await rp;

      // Timer should have been reset; another 20s does NOT trigger disconnect
      vi.advanceTimersByTime(20_000);
      expect(client.ended).toBe(false);
      // 30s after the last command, it should fire
      vi.advanceTimersByTime(10_000);
      expect(client.ended).toBe(true);
    });

    it('long-running command does NOT trip the idle timer mid-flight', async () => {
      // Regression test for the idle-fire-during-command race. idleDisconnectMs is short, command
      // takes longer — the runner must keep the idle timer cancelled until the command settles.
      const runner = build({ idleDisconnectMs: 5_000 });
      const channel = new FakeChannel();
      client.prepareChannel(channel);
      const cp = runner.connect();
      client.triggerReady();
      await cp;

      const rp = runner.run({ command: 'slow', timeoutMs: 30_000 });
      await vi.advanceTimersByTimeAsync(0); // let exec attach handlers

      vi.advanceTimersByTime(10_000); // exec is still in flight — idle window long passed
      expect(client.ended).toBe(false);

      channel.emitData('done\n');
      channel.finish(0);
      await rp;

      // Now the command has settled; the idle timer is re-armed for 5s
      vi.advanceTimersByTime(4_999);
      expect(client.ended).toBe(false);
      vi.advanceTimersByTime(1);
      expect(client.ended).toBe(true);
    });

    it('lazily reconnects on next run() after an idle disconnect', async () => {
      const runner = build({ idleDisconnectMs: 30_000 });
      const cp = runner.connect();
      client.triggerReady();
      await cp;

      vi.advanceTimersByTime(30_000);
      expect(client.ended).toBe(true);

      // After idle close, next run() reconnects.
      const channel = new FakeChannel();
      client.prepareChannel(channel);
      const rp = runner.run({ command: 'echo back', timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(0); // let openClient attach listeners
      client.triggerReady();
      await vi.advanceTimersByTimeAsync(0); // let exec attach handlers
      channel.emitData('back\n');
      channel.finish(0);
      const result = await rp;
      expect(result.stdout).toBe('back\n');
      expect(client.connectCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('idle-fire racing with new run() resolves cleanly via lazy reconnect', async () => {
      // Spec section 8.1: a pending idle-fire that races with a new run() is harmless because
      // run() calls connect() first, which detects the dead client and reconnects.
      const runner = build({ idleDisconnectMs: 30_000 });
      const cp = runner.connect();
      client.triggerReady();
      await cp;

      // Advance just enough to fire the idle disconnect.
      vi.advanceTimersByTime(30_000);
      expect(client.ended).toBe(true);

      // Immediately issue a new run — should reconnect via openClient and complete.
      const channel = new FakeChannel();
      client.prepareChannel(channel);
      const rp = runner.run({ command: 'after-idle', timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      client.triggerReady();
      await vi.advanceTimersByTimeAsync(0);
      channel.emitData('ok\n');
      channel.finish(0);
      const result = await rp;
      expect(result.stdout).toBe('ok\n');
      expect(client.connectCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('explicit disconnect() cancels the pending idle timer (no double disconnect)', async () => {
      const runner = build({ idleDisconnectMs: 30_000 });
      const cp = runner.connect();
      client.triggerReady();
      await cp;

      await runner.disconnect();
      const endsBefore = client.ended;
      vi.advanceTimersByTime(60_000);
      // No additional end() calls beyond what disconnect() already did
      expect(client.ended).toBe(endsBefore);
    });
  });
});
