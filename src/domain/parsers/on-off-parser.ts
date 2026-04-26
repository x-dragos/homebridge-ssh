export type OnOffParserMode = 'exact' | 'contains' | 'regex';

export interface OnOffParserConfig {
  readonly onValue: string;
  readonly mode: OnOffParserMode;
}

export class OnOffParser {
  private readonly regex: RegExp | null;

  constructor(private readonly config: OnOffParserConfig) {
    this.regex = config.mode === 'regex' ? new RegExp(config.onValue) : null;
  }

  parse(stdout: string): boolean {
    const trimmed = stdout.replace(/\s+$/, '');
    switch (this.config.mode) {
      case 'exact':
        return trimmed === this.config.onValue;
      case 'contains':
        return trimmed.includes(this.config.onValue);
      case 'regex':
        if (!this.regex) {
          throw new Error('regex not initialised');
        }
        return this.regex.test(trimmed);
    }
  }
}
