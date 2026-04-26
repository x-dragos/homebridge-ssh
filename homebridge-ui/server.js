// homebridge-ssh-platform custom plugin UI server.
// Spawned as a child process when the settings modal opens; killed when it closes.
// Exposes `/test-connection` and `/test-command` endpoints used by public/index.html.
//
// Note: Client#exec below is ssh2's SSH-channel-request method (run a command on
// the REMOTE host over SSH), NOT child_process.exec. Same security model as the
// rest of this plugin: the user explicitly configures the commands they want run.
//
// ESM module — root package.json has "type": "module".

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import ssh2 from 'ssh2';
import fs from 'node:fs';

const PROBE_COMMAND = 'echo ok';
const PROBE_TIMEOUT_MS = 5000;

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/test-connection', this.testConnection.bind(this));
    this.onRequest('/test-command', this.testCommand.bind(this));
    this.ready();
  }

  async testConnection(payload) {
    const host = payload && payload.host;
    assertHost(host);
    const startedAt = Date.now();
    try {
      const result = await runSsh(host, { command: PROBE_COMMAND, timeoutMs: PROBE_TIMEOUT_MS });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        exitCode: result.exitCode,
        stdout: truncate(result.stdout, 256),
      };
    } catch (err) {
      throw new RequestError(err.message || 'connection failed', { status: 502 });
    }
  }

  async testCommand(payload) {
    const host = payload && payload.host;
    const command = payload && payload.command;
    assertHost(host);
    if (!command || typeof command.command !== 'string' || command.command.trim() === '') {
      throw new RequestError('command is required', { status: 400 });
    }
    const timeoutMs = typeof command.timeoutMs === 'number' && command.timeoutMs > 0 ? command.timeoutMs : 5000;
    const startedAt = Date.now();
    try {
      const result = await runSsh(host, { command: command.command, timeoutMs });
      return {
        ok: true,
        exitCode: result.exitCode,
        stdout: truncate(result.stdout, 1024),
        stderr: truncate(result.stderr, 1024),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      throw new RequestError(err.message || 'command failed', { status: 502 });
    }
  }
}

function assertHost(host) {
  if (!host || typeof host !== 'object') {
    throw new RequestError('host is required', { status: 400 });
  }
  if (!host.ssh || typeof host.ssh.host !== 'string' || typeof host.ssh.user !== 'string') {
    throw new RequestError('host.ssh.host and host.ssh.user are required', { status: 400 });
  }
  const auth = host.ssh.auth;
  if (!auth || typeof auth.method !== 'string') {
    throw new RequestError('host.ssh.auth.method is required', { status: 400 });
  }
}

function buildConnectConfig(host) {
  const ssh = host.ssh;
  const base = {
    host: ssh.host,
    port: ssh.port || 22,
    username: ssh.user,
    readyTimeout: ssh.connectTimeoutMs || 10000,
  };
  switch (ssh.auth.method) {
    case 'key': {
      if (!ssh.auth.privateKeyPath) {
        throw new Error('privateKeyPath is required for key auth');
      }
      const privateKey = fs.readFileSync(ssh.auth.privateKeyPath);
      const keyConfig = { ...base, privateKey };
      if (ssh.auth.passphrase) {
        keyConfig.passphrase = ssh.auth.passphrase;
      }
      return keyConfig;
    }
    case 'password':
      if (!ssh.auth.password) {
        throw new Error('password is required for password auth');
      }
      return { ...base, password: ssh.auth.password };
    case 'agent': {
      const sock = process.env.SSH_AUTH_SOCK;
      if (!sock) {
        throw new Error('SSH_AUTH_SOCK is not set; cannot use agent auth');
      }
      return { ...base, agent: sock };
    }
    default:
      throw new Error(`unknown auth method: ${ssh.auth.method}`);
  }
}

/** Open one ssh2 client, run a command on the remote, return { exitCode, stdout, stderr }. */
function runSsh(host, command) {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`command timed out after ${command.timeoutMs}ms`));
    }, command.timeoutMs);

    client.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    client.on('ready', () => {
      client.exec(command.command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          finish(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        stream.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('exit', (code) => {
          exitCode = typeof code === 'number' ? code : 1;
        });
        stream.on('close', () => {
          clearTimeout(timer);
          finish(null, { exitCode, stdout, stderr });
        });
      });
    });

    let connectConfig;
    try {
      connectConfig = buildConnectConfig(host);
    } catch (err) {
      clearTimeout(timer);
      finish(err);
      return;
    }
    client.connect(connectConfig);
  });
}

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

(() => new UiServer())();
