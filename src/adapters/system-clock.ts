import type { Clock, TimerHandle } from '../domain/ports/clock.js';

export class SystemClock implements Clock {
  private nextId = 1;
  private readonly handles = new Map<number, NodeJS.Timeout>();

  now(): number {
    return Date.now();
  }

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    const timer = setTimeout(() => {
      this.handles.delete(id);
      handler();
    }, delayMs);
    this.handles.set(id, timer);
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    const timer = this.handles.get(handle.id);
    if (timer) {
      clearTimeout(timer);
      this.handles.delete(handle.id);
    }
  }
}
