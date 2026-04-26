import type { CommandResult } from '../../src/domain/command/command-result.js';
import type { CommandSpec } from '../../src/domain/command/command-spec.js';
import type { CommandRunner, DisconnectListener } from '../../src/domain/ports/command-runner.js';

type ResponseEntry = { kind: 'result'; result: CommandResult } | { kind: 'error'; error: Error };

export class FakeCommandRunner implements CommandRunner {
  public readonly invocations: CommandSpec[] = [];
  public connectCount = 0;
  public disconnectCount = 0;
  private readonly listeners = new Set<DisconnectListener>();
  private readonly responses = new Map<string, ResponseEntry[]>();
  private readonly defaults = new Map<string, ResponseEntry>();

  enqueue(commandPrefix: string, response: ResponseEntry): void {
    const list = this.responses.get(commandPrefix) ?? [];
    list.push(response);
    this.responses.set(commandPrefix, list);
  }

  setDefault(commandPrefix: string, response: ResponseEntry): void {
    this.defaults.set(commandPrefix, response);
  }

  async connect(): Promise<void> {
    this.connectCount++;
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.invocations.push(spec);
    const matchKey = [...this.responses.keys(), ...this.defaults.keys()].find((prefix) =>
      spec.command.startsWith(prefix),
    );
    if (!matchKey) {
      throw new Error(`FakeCommandRunner: no scripted response for command: ${spec.command}`);
    }
    const queued = this.responses.get(matchKey);
    if (queued && queued.length > 0) {
      const next = queued.shift()!;
      if (queued.length === 0) {
        this.responses.delete(matchKey);
      }
      return this.deliver(next);
    }
    const fallback = this.defaults.get(matchKey)!;
    return this.deliver(fallback);
  }

  async disconnect(): Promise<void> {
    this.disconnectCount++;
  }

  onDisconnect(listener: DisconnectListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  simulateDisconnect(reason: Error): void {
    for (const listener of this.listeners) {
      listener(reason);
    }
  }

  private deliver(entry: ResponseEntry): Promise<CommandResult> {
    if (entry.kind === 'error') {
      return Promise.reject(entry.error);
    }
    return Promise.resolve(entry.result);
  }
}

export const ok = (overrides: Partial<CommandResult> = {}): ResponseEntry => ({
  kind: 'result',
  result: { stdout: '', stderr: '', exitCode: 0, durationMs: 1, ...overrides },
});

export const fail = (error: Error): ResponseEntry => ({ kind: 'error', error });
