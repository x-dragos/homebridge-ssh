import type { CommandRunner } from '../../domain/ports/command-runner.js';
import type { Logger } from '../../domain/ports/logger.js';
import type { HostConfig } from '../../domain/config/plugin-config.js';
import { SshCommandRunner } from './ssh-command-runner.js';

export class SshConnectionPool {
  private readonly runners = new Map<string, SshCommandRunner>();

  constructor(private readonly logger: Logger) {}

  get(host: HostConfig): CommandRunner {
    let runner = this.runners.get(host.id);
    if (!runner) {
      if (host.ssh.auth.method === 'password') {
        this.logger.warn('host uses password auth — key auth is preferred', { host: host.id });
      }
      runner = new SshCommandRunner({
        logger: this.logger.child({ host: host.id }),
        sshConfig: host.ssh,
      });
      runner.onDisconnect((reason) => {
        this.logger.warn('host disconnected — will reconnect on next command', {
          host: host.id,
          reason: reason.message,
        });
      });
      this.runners.set(host.id, runner);
    }
    return runner;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.disconnect()));
    this.runners.clear();
  }
}
