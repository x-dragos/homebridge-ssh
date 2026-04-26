export type TimerHandle = { readonly id: number };

export interface Clock {
  now(): number;
  setTimeout(handler: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}
