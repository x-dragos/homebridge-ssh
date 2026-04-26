import type { Logging } from 'homebridge';
import type { LogFields, Logger } from '../domain/ports/logger.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const REDACTED_KEYS = new Set(['password', 'passphrase', 'privateKey', 'privateKeyPath']);

function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value.includes(' ') ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatMessage(prefixes: string[], message: string, fields: LogFields): string {
  const prefix = prefixes.length > 0 ? prefixes.map((p) => `[${p}]`).join(' ') + ' ' : '';
  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length === 0) {
    return `${prefix}${message}`;
  }
  const parts = fieldKeys.map((key) => {
    const raw = (fields as Record<string, unknown>)[key];
    const value = REDACTED_KEYS.has(key) ? '***' : stringify(raw);
    return `${key}=${value}`;
  });
  return `${prefix}${message} ${parts.join(' ')}`;
}

export class HomebridgeLogger implements Logger {
  constructor(
    private readonly hb: Logging,
    private readonly minLevel: LogLevel,
    private readonly prefixes: string[] = [],
    private readonly bound: LogFields = {},
  ) {}

  debug(message: string, fields: LogFields = {}): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }
  error(message: string, error?: unknown, fields: LogFields = {}): void {
    const composed =
      error instanceof Error
        ? { ...fields, errorMessage: error.message, errorName: error.name }
        : error !== undefined
          ? { ...fields, error: String(error) }
          : fields;
    this.write('error', message, composed);
  }

  child(boundFields: Record<string, string>): Logger {
    const newPrefixes = [...this.prefixes, ...Object.values(boundFields)];
    return new HomebridgeLogger(this.hb, this.minLevel, newPrefixes, { ...this.bound, ...boundFields });
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) {
      return;
    }
    const merged = { ...this.bound, ...fields };
    const formatted = formatMessage(this.prefixes, message, merged);
    switch (level) {
      case 'debug':
        // Homebridge's `log.debug` is silenced unless Homebridge itself runs in debug mode.
        // Since the user explicitly set this plugin's logLevel to 'debug', promote to info
        // (with a tag) so the messages actually appear without requiring -D globally.
        this.hb.info(`[debug] ${formatted}`);
        break;
      case 'info':
        this.hb.info(formatted);
        break;
      case 'warn':
        this.hb.warn(formatted);
        break;
      case 'error':
        this.hb.error(formatted);
        break;
    }
  }
}
