import type { Clock, TimerHandle } from '../../src/domain/ports/clock.js';

interface ScheduledCallback {
  id: number;
  fireAt: number;
  handler: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  private currentTime = 0;
  private nextId = 1;
  private scheduled: ScheduledCallback[] = [];

  now(): number {
    return this.currentTime;
  }

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.scheduled.push({ id, fireAt: this.currentTime + delayMs, handler, cancelled: false });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    const found = this.scheduled.find((s) => s.id === handle.id);
    if (found) {
      found.cancelled = true;
    }
  }

  advance(ms: number): void {
    const target = this.currentTime + ms;
    while (true) {
      const due = this.scheduled
        .filter((s) => !s.cancelled && s.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!due) {
        break;
      }
      this.currentTime = due.fireAt;
      due.cancelled = true;
      due.handler();
    }
    this.currentTime = target;
  }
}
