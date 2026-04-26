import type { CommandResult } from '../command/command-result.js';
import type { CommandSpec } from '../command/command-spec.js';

export type DisconnectListener = (reason: Error) => void;

export interface CommandRunner {
  /** Idempotent. Establishes the underlying connection if not already connected. */
  connect(): Promise<void>;
  /** Runs a command. Throws a CommandRunnerError subclass on any failure. */
  run(spec: CommandSpec): Promise<CommandResult>;
  /** Idempotent. Closes the underlying connection cleanly. */
  disconnect(): Promise<void>;
  /** Subscribes to unexpected disconnects. Returns an unsubscribe function. */
  onDisconnect(listener: DisconnectListener): () => void;
}
