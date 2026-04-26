import { describe, expect, it } from 'vitest';
import { HomebridgeLogger } from '../../src/adapters/homebridge-logger.js';

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  args: unknown[];
}

function fakeHbLog() {
  const calls: LogCall[] = [];
  const log = {
    debug: (...args: unknown[]) => calls.push({ level: 'debug', args }),
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
    error: (...args: unknown[]) => calls.push({ level: 'error', args }),
    log: () => {},
    success: () => {},
    prefix: '',
  };
  return { log, calls };
}

describe('HomebridgeLogger', () => {
  it('forwards messages with structured fields appended', () => {
    const { log, calls } = fakeHbLog();
    const logger = new HomebridgeLogger(log as never, 'info');
    logger.info('opened gate', { host: 'gate-pi' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.level).toBe('info');
    expect(String(calls[0]!.args[0])).toContain('opened gate');
    expect(String(calls[0]!.args[0])).toContain('host=gate-pi');
  });

  it('redacts password, passphrase, privateKey fields', () => {
    const { log, calls } = fakeHbLog();
    const logger = new HomebridgeLogger(log as never, 'debug');
    logger.debug('connecting', { user: 'pi', password: 'secret123', passphrase: 'p', privateKey: 'PEM' });
    const text = String(calls[0]!.args[0]);
    expect(text).toContain('user=pi');
    expect(text).toContain('password=***');
    expect(text).toContain('passphrase=***');
    expect(text).toContain('privateKey=***');
    expect(text).not.toContain('secret123');
  });

  it('drops debug messages when level=info', () => {
    const { log, calls } = fakeHbLog();
    const logger = new HomebridgeLogger(log as never, 'info');
    logger.debug('chatty');
    expect(calls).toHaveLength(0);
  });

  it('child loggers prepend bound fields to every message', () => {
    const { log, calls } = fakeHbLog();
    const logger = new HomebridgeLogger(log as never, 'info').child({ host: 'gate-pi', accessory: 'Front Gate' });
    logger.info('hello');
    const text = String(calls[0]!.args[0]);
    expect(text).toContain('[gate-pi]');
    expect(text).toContain('[Front Gate]');
    expect(text).toContain('hello');
  });

  it('error includes the error message', () => {
    const { log, calls } = fakeHbLog();
    const logger = new HomebridgeLogger(log as never, 'info');
    logger.error('boom', new Error('connection refused'));
    const text = String(calls[0]!.args[0]);
    expect(text).toContain('boom');
    expect(text).toContain('connection refused');
  });
});
