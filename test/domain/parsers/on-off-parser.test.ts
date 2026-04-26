import { describe, expect, it } from 'vitest';
import { OnOffParser } from '../../../src/domain/parsers/on-off-parser.js';

describe('OnOffParser', () => {
  describe('exact mode', () => {
    const parser = new OnOffParser({ onValue: 'playing', mode: 'exact' });

    it('returns true on exact match (trim trailing newline)', () => {
      expect(parser.parse('playing\n')).toBe(true);
    });
    it('returns false when value differs', () => {
      expect(parser.parse('paused\n')).toBe(false);
    });
    it('is case-sensitive in exact mode', () => {
      expect(parser.parse('Playing')).toBe(false);
    });
    it('returns false on empty stdout', () => {
      expect(parser.parse('')).toBe(false);
    });
  });

  describe('contains mode', () => {
    const parser = new OnOffParser({ onValue: 'running', mode: 'contains' });

    it('returns true if substring present', () => {
      expect(parser.parse('service is running fine')).toBe(true);
    });
    it('returns false if substring absent', () => {
      expect(parser.parse('service stopped')).toBe(false);
    });
  });

  describe('regex mode', () => {
    const parser = new OnOffParser({ onValue: '^ON\\b', mode: 'regex' });

    it('returns true when pattern matches', () => {
      expect(parser.parse('ON 100%')).toBe(true);
    });
    it('returns false when pattern does not match', () => {
      expect(parser.parse('OFF')).toBe(false);
    });
    it('throws on invalid regex at construction time', () => {
      expect(() => new OnOffParser({ onValue: '(', mode: 'regex' })).toThrow();
    });
  });
});
