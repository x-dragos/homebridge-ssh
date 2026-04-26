import { describe, expect, it } from 'vitest';
import { GarageStateParser } from '../../../src/domain/parsers/garage-state-parser.js';
import type { GarageStateMapping } from '../../../src/domain/config/plugin-config.js';
import { DoorState } from '../../../src/domain/orchestrators/door-state.js';

const fullMapping: GarageStateMapping = {
  open: { match: 'OPEN', mode: 'exact' },
  closed: { match: 'CLOSED', mode: 'exact' },
  opening: { match: 'OPENING', mode: 'exact' },
  closing: { match: 'CLOSING', mode: 'exact' },
};

describe('GarageStateParser', () => {
  describe('with full mapping', () => {
    const parser = new GarageStateParser(fullMapping);

    it.each([
      ['OPEN', DoorState.Open],
      ['CLOSED', DoorState.Closed],
      ['OPENING', DoorState.Opening],
      ['CLOSING', DoorState.Closing],
    ])('parses "%s" → %s', (input, expected) => {
      expect(parser.parse(input)).toBe(expected);
    });

    it('trims trailing whitespace before matching', () => {
      expect(parser.parse('OPEN\n  ')).toBe(DoorState.Open);
    });

    it('returns null when nothing matches', () => {
      expect(parser.parse('UNKNOWN STATE')).toBeNull();
    });

    it('first rule wins when patterns overlap', () => {
      const overlap = new GarageStateParser({
        open: { match: 'O', mode: 'contains' },
        closed: { match: 'OPEN', mode: 'contains' },
        opening: { match: 'X', mode: 'exact' },
        closing: { match: 'Y', mode: 'exact' },
      });
      expect(overlap.parse('OPEN')).toBe(DoorState.Open);
    });
  });

  describe('with minimal mapping (open + closed only)', () => {
    const parser = new GarageStateParser({
      open: { match: 'OPEN', mode: 'exact' },
      closed: { match: 'CLOSED', mode: 'exact' },
    });

    it('parses recognised values', () => {
      expect(parser.parse('OPEN')).toBe(DoorState.Open);
      expect(parser.parse('CLOSED')).toBe(DoorState.Closed);
    });

    it('returns null for opening/closing because no rule defined', () => {
      expect(parser.parse('OPENING')).toBeNull();
      expect(parser.parse('CLOSING')).toBeNull();
    });
  });

  it('supports regex mode with anchors', () => {
    const re = new GarageStateParser({
      open: { match: '^op_\\d+$', mode: 'regex' },
      closed: { match: '^cl_\\d+$', mode: 'regex' },
    });
    expect(re.parse('op_42')).toBe(DoorState.Open);
    expect(re.parse('cl_7')).toBe(DoorState.Closed);
    expect(re.parse('op_xx')).toBeNull();
  });
});
