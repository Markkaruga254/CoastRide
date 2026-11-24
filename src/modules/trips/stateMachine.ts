export type TripState =
  | 'REQUESTED'
  | 'OFFERED'
  | 'CONFIRMED'
  | 'ARRIVED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_DRIVER';

export type TripEvent =
  | 'BOOKING_CREATED'
  | 'DRIVER_OFFERED'
  | 'NO_DRIVER_AVAILABLE'
  | 'DRIVER_ACCEPTED'
  | 'DRIVER_DECLINED'
  | 'OFFER_TIMEOUT'
  | 'DRIVER_ARRIVED'
  | 'TRIP_COMPLETED'
  | 'CANCELLED'
  | 'PICKUP_DELAYED';

export class IllegalTransitionError extends Error {
  readonly state: TripState;
  readonly event: TripEvent;

  constructor(state: TripState, event: TripEvent) {
    super(
      `Illegal transition from "${state}" on event "${event}"`,
    );
    this.name = 'IllegalTransitionError';
    this.state = state;
    this.event = event;
  }
}

// Transition table per docs/SPEC.md: [from, event] -> to.
// PICKUP_DELAYED is handled separately: state unchanged, allowed only in
// REQUESTED / OFFERED / CONFIRMED.
const TRANSITIONS: Record<string, Record<string, TripState>> = {
  REQUESTED: {
    DRIVER_OFFERED: 'OFFERED',
    NO_DRIVER_AVAILABLE: 'NO_DRIVER',
  },
  OFFERED: {
    DRIVER_ACCEPTED: 'CONFIRMED',
    DRIVER_DECLINED: 'REQUESTED',
    OFFER_TIMEOUT: 'REQUESTED',
  },
  CONFIRMED: {
    DRIVER_ARRIVED: 'ARRIVED',
  },
  ARRIVED: {
    TRIP_COMPLETED: 'COMPLETED',
  },
  // REQUESTED/OFFERED/CONFIRMED/ARRIVED all accept CANCELLED -> CANCELLED
};

const CANCELLABLE: TripState[] = [
  'REQUESTED',
  'OFFERED',
  'CONFIRMED',
  'ARRIVED',
];

const DELAYABLE: TripState[] = ['REQUESTED', 'OFFERED', 'CONFIRMED'];

export function applyEvent(
  state: TripState,
  event: TripEvent,
): TripState {
  // PICKUP_DELAYED leaves state unchanged; only allowed in REQUESTED/OFFERED/CONFIRMED.
  if (event === 'PICKUP_DELAYED') {
    if (!DELAYABLE.includes(state)) {
      throw new IllegalTransitionError(state, event);
    }
    return state;
  }

  // CANCELLED transitions from any non-terminal state.
  if (event === 'CANCELLED') {
    if (CANCELLABLE.includes(state)) {
      return 'CANCELLED';
    }
    throw new IllegalTransitionError(state, event);
  }

  const byEvent = TRANSITIONS[state];
  if (!byEvent) {
    throw new IllegalTransitionError(state, event);
  }

  const next = byEvent[event];
  if (!next) {
    throw new IllegalTransitionError(state, event);
  }

  return next;
}

export function isTerminal(state: TripState): boolean {
  return state === 'COMPLETED' || state === 'CANCELLED' || state === 'NO_DRIVER';
}

export function isCancellable(state: TripState): boolean {
  return CANCELLABLE.includes(state);
}

export function isDelayable(state: TripState): boolean {
  return DELAYABLE.includes(state);
}
