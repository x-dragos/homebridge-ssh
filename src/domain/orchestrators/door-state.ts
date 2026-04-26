export const DoorState = {
  Open: 'open',
  Closed: 'closed',
  Opening: 'opening',
  Closing: 'closing',
  Stopped: 'stopped',
} as const;

export type DoorState = (typeof DoorState)[keyof typeof DoorState];

export const ALL_DOOR_STATES: readonly DoorState[] = [
  DoorState.Open,
  DoorState.Closed,
  DoorState.Opening,
  DoorState.Closing,
  DoorState.Stopped,
];
