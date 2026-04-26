import type { LogFields, Logger } from '../../src/domain/ports/logger.js';

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
  error?: unknown;
}

export class FakeLogger implements Logger {
  public readonly entries: LogEntry[] = [];

  constructor(private readonly bound: LogFields = {}) {}

  debug(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'debug', message, fields: { ...this.bound, ...fields } });
  }
  info(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'info', message, fields: { ...this.bound, ...fields } });
  }
  warn(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'warn', message, fields: { ...this.bound, ...fields } });
  }
  error(message: string, error?: unknown, fields: LogFields = {}): void {
    this.entries.push({ level: 'error', message, fields: { ...this.bound, ...fields }, error });
  }
  child(boundFields: Record<string, string>): Logger {
    const child = new FakeLogger({ ...this.bound, ...boundFields });
    Object.defineProperty(child, 'entries', { value: this.entries });
    return child;
  }
}
