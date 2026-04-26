import type { GarageStateMapping } from '../config/plugin-config.js';
import { DoorState } from '../orchestrators/door-state.js';

interface CompiledRule {
  state: DoorState;
  match: string;
  mode: 'exact' | 'contains' | 'regex';
  regex: RegExp | null;
}

export class GarageStateParser {
  private readonly rules: readonly CompiledRule[];

  constructor(mapping: GarageStateMapping) {
    const rules: CompiledRule[] = [];
    const append = (state: DoorState, rule: { match: string; mode: 'exact' | 'contains' | 'regex' } | undefined) => {
      if (!rule) {
        return;
      }
      rules.push({
        state,
        match: rule.match,
        mode: rule.mode,
        regex: rule.mode === 'regex' ? new RegExp(rule.match) : null,
      });
    };
    append(DoorState.Open, mapping.open);
    append(DoorState.Closed, mapping.closed);
    append(DoorState.Opening, mapping.opening);
    append(DoorState.Closing, mapping.closing);
    this.rules = rules;
  }

  parse(stdout: string): DoorState | null {
    const trimmed = stdout.replace(/\s+$/, '');
    for (const rule of this.rules) {
      if (this.matches(trimmed, rule)) {
        return rule.state;
      }
    }
    return null;
  }

  private matches(value: string, rule: CompiledRule): boolean {
    switch (rule.mode) {
      case 'exact':
        return value === rule.match;
      case 'contains':
        return value.includes(rule.match);
      case 'regex':
        if (!rule.regex) {
          throw new Error('regex not initialised');
        }
        return rule.regex.test(value);
    }
  }
}
