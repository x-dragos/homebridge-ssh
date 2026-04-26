import { describe, expect, it, vi } from 'vitest';
import { SystemClock } from '../../src/adapters/system-clock.js';

describe('SystemClock', () => {
  it('returns current Date.now()', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const reported = clock.now();
    const after = Date.now();
    expect(reported).toBeGreaterThanOrEqual(before);
    expect(reported).toBeLessThanOrEqual(after);
  });

  it('schedules and fires a setTimeout callback', () => {
    vi.useFakeTimers();
    try {
      const clock = new SystemClock();
      const handler = vi.fn();
      clock.setTimeout(handler, 1000);
      vi.advanceTimersByTime(999);
      expect(handler).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled callback', () => {
    vi.useFakeTimers();
    try {
      const clock = new SystemClock();
      const handler = vi.fn();
      const handle = clock.setTimeout(handler, 1000);
      clock.clearTimeout(handle);
      vi.advanceTimersByTime(2000);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
