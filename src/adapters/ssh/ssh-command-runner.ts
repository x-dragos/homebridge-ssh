import { readFileSync } from 'node:fs';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { CommandResult } from '../../domain/command/command-result.js';
import type { CommandSpec } from '../../domain/command/command-spec.js';
import {
  CommandRunnerConnectError,
  CommandRunnerNonZeroExitError,
  CommandRunnerTimeoutError,
  CommandRunnerTransportError,
} from '../../domain/command/errors.js';
import type { CommandRunner, DisconnectListener } from '../../domain/ports/command-runner.js';
import type { Logger } from '../../domain/ports/logger.js';
import type { SshAuthConfig } from '../../domain/config/plugin-config.js';

export interface SshConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: SshAuthConfig;
  readonly connectTimeoutMs: number;
  readonly keepaliveIntervalMs: number;
  /** Idle disconnect: 0 = never disconnect (default). > 0 = close after that many ms of no commands. */
  readonly idleDisconnectMs: number;
}

export interface SshCommandRunnerDeps {
  readonly logger: Logger;
  readonly sshConfig: SshConnectionConfig;
  readonly clientFactory?: () => Client;
  readonly readKey?: (path: string) => Buffer;
}

const DEBUG_TRUNCATE_BYTES = 512;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

export class SshCommandRunner implements CommandRunner {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private idleHandle: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<DisconnectListener>();
  private readonly clientFactory: () => Client;
  private readonly readKey: (path: string) => Buffer;

  constructor(private readonly deps: SshCommandRunnerDeps) {
    this.clientFactory = deps.clientFactory ?? (() => new Client());
    this.readKey = deps.readKey ?? ((path) => readFileSync(path));
  }

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.openClient();
    try {
      await this.connecting;
      this.armIdleTimer();
    } finally {
      this.connecting = null;
    }
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.cancelIdleTimer();
    await this.connect();
    // connect() may have armed an idle timer if it actually opened a connection.
    // Cancel it again so a long-running command can't be cut short by a fresh idle fire.
    this.cancelIdleTimer();
    const client = this.client!;
    const expected = spec.expectExitCode ?? 0;
    const startedAt = Date.now();

    return new Promise<CommandResult>((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      let settled = false;
      let activeChannel: ClientChannel | null = null;
      const settle = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        // Re-arm idle timer when the command settles, regardless of success or failure.
        this.armIdleTimer();
        fn();
      };

      client.exec(spec.command, (err, channel) => {
        if (err) {
          // Channel-level transport error (eg. server refused channel-open
          // because MaxSessions is exhausted on this connection). The
          // persistent client is in a poisoned state — every subsequent exec
          // on it will hit the same wall — so drop it and let the next run
          // lazily reconnect.
          this.recycleClient(new Error(`ssh client recycled: ${err.message}`));
          settle(() => reject(new CommandRunnerTransportError(err.message, { cause: err })));
          return;
        }
        let stdout = '';
        let stderr = '';
        activeChannel = channel as ClientChannel;
        activeChannel.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        activeChannel.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        let exitCode: number | null = null;
        activeChannel.on('exit', (code: number) => {
          exitCode = code;
        });
        activeChannel.on('close', () => {
          settle(() => {
            const code = exitCode ?? -1;
            const durationMs = Date.now() - startedAt;
            const result: CommandResult = { stdout, stderr, exitCode: code, durationMs };
            this.deps.logger.debug('exec complete', {
              command: spec.command,
              exitCode: code,
              durationMs,
              stdout: truncate(stdout, DEBUG_TRUNCATE_BYTES),
              stderr: truncate(stderr, DEBUG_TRUNCATE_BYTES),
            });
            if (code !== expected) {
              reject(new CommandRunnerNonZeroExitError(code, stderr, expected));
              return;
            }
            resolve(result);
          });
        });
      });

      timeoutHandle = setTimeout(() => {
        // Best-effort: terminate the remote process and free the channel slot.
        // Without this, a hanging remote command keeps consuming a session on
        // the persistent SSH connection (default sshd MaxSessions = 10), and
        // after enough leaks every new exec returns "Channel open failure".
        if (activeChannel) {
          try {
            activeChannel.signal('KILL');
          } catch {
            /* ignore - channel may already be closed or signal unsupported */
          }
          try {
            activeChannel.close();
          } catch {
            /* ignore */
          }
        }
        settle(() => reject(new CommandRunnerTimeoutError(spec.timeoutMs)));
      }, spec.timeoutMs);
    });
  }

  /**
   * Tear down the current SSH client. Used when an exec-level error indicates
   * the connection itself is no longer usable. Synchronously nulls the client
   * reference so concurrent run() calls don't grab a poisoned client, fires
   * onDisconnect listeners directly (the natural 'close' event handler would
   * otherwise no-op because we already cleared this.client), and ends the
   * transport.
   */
  private recycleClient(reason: Error): void {
    if (!this.client) {
      return;
    }
    const c = this.client;
    this.client = null;
    this.cancelIdleTimer();
    try {
      c.end();
    } catch {
      /* ignore */
    }
    for (const listener of this.listeners) {
      listener(reason);
    }
  }

  async disconnect(): Promise<void> {
    this.cancelIdleTimer();
    if (!this.client) {
      return;
    }
    this.client.end();
    this.client = null;
  }

  onDisconnect(listener: DisconnectListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private armIdleTimer(): void {
    if (this.deps.sshConfig.idleDisconnectMs <= 0) {
      return;
    }
    this.cancelIdleTimer();
    this.idleHandle = setTimeout(() => {
      this.idleHandle = null;
      this.deps.logger.debug('idle disconnect firing', { idleDisconnectMs: this.deps.sshConfig.idleDisconnectMs });
      void this.disconnect();
    }, this.deps.sshConfig.idleDisconnectMs);
  }

  private cancelIdleTimer(): void {
    if (this.idleHandle) {
      clearTimeout(this.idleHandle);
      this.idleHandle = null;
    }
  }

  private async openClient(): Promise<void> {
    const client = this.clientFactory();
    const connectConfig: ConnectConfig = this.buildConnectConfig();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(new CommandRunnerConnectError(`connect timed out after ${this.deps.sshConfig.connectTimeoutMs}ms`)),
        );
      }, this.deps.sshConfig.connectTimeoutMs);

      client.once('ready', () => {
        clearTimeout(timer);
        settle(() => {
          this.client = client;
          this.attachLifecycleListeners(client);
          resolve();
        });
      });

      client.once('error', (err: Error) => {
        clearTimeout(timer);
        settle(() => reject(new CommandRunnerConnectError(err.message, { cause: err })));
      });

      client.connect(connectConfig);
    });
  }

  private attachLifecycleListeners(client: Client): void {
    client.on('error', (err: Error) => {
      this.deps.logger.warn('ssh client error', { reason: err.message });
    });
    client.on('close', () => {
      const wasConnected = this.client === client;
      if (this.client === client) {
        this.client = null;
        // Connection gone — pending idle disconnect is no longer meaningful.
        this.cancelIdleTimer();
      }
      if (wasConnected) {
        const reason = new Error('ssh connection closed');
        for (const listener of this.listeners) {
          listener(reason);
        }
      }
    });
  }

  private buildConnectConfig(): ConnectConfig {
    const base: ConnectConfig = {
      host: this.deps.sshConfig.host,
      port: this.deps.sshConfig.port,
      username: this.deps.sshConfig.user,
      readyTimeout: this.deps.sshConfig.connectTimeoutMs,
      keepaliveInterval: this.deps.sshConfig.keepaliveIntervalMs > 0 ? this.deps.sshConfig.keepaliveIntervalMs : 0,
    };
    const auth = this.deps.sshConfig.auth;
    switch (auth.method) {
      case 'key':
        return {
          ...base,
          privateKey: this.readKey(auth.privateKeyPath),
          ...(auth.passphrase ? { passphrase: auth.passphrase } : {}),
        };
      case 'password':
        return { ...base, password: auth.password };
      case 'agent':
        return {
          ...base,
          ...(process.env.SSH_AUTH_SOCK ? { agent: process.env.SSH_AUTH_SOCK } : {}),
        };
    }
  }
}
