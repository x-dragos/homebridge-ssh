export interface CommandSpec {
  readonly command: string;
  readonly timeoutMs: number;
  /** When provided, exit codes other than this become CommandRunnerNonZeroExitError. Default: 0. */
  readonly expectExitCode?: number | undefined;
}
