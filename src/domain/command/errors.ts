export class CommandRunnerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class CommandRunnerConnectError extends CommandRunnerError {}
export class CommandRunnerTransportError extends CommandRunnerError {}
export class CommandRunnerTimeoutError extends CommandRunnerError {
  constructor(
    public readonly timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    super(`command timed out after ${timeoutMs}ms`, options);
  }
}
export class CommandRunnerNonZeroExitError extends CommandRunnerError {
  constructor(
    public readonly exitCode: number,
    public readonly stderr: string,
    public readonly expectedExitCode: number,
  ) {
    super(`command exited with ${exitCode} (expected ${expectedExitCode})`);
  }
}
