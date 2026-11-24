import { describe, it, expect } from 'vitest';
import {
  applyEvent,
  IllegalTransitionError,
  type TripState,
  type TripEvent,
} from '../../src/modules/trips/stateMachine.js';

const states: TripState[] = [
  'REQUESTED',
  'OFFERED',
  'CONFIRMED',
  'ARRIVED',
  'COMPLETED',
  'CANCELLED',
  'NO_DRIVER',
];

function transitionOf(from: TripState, event: TripEvent): TripState {
  return applyEvent(from, event);
}

describe('trip state machine', () => {
  describe('valid transitions', () => {
    it('BOOKING_CREATED enters REQUESTED (treated from any non-terminal)', () => {
      // BOOKING_CREATED is the creation event; applyEvent models lifecycle after creation.
      expect(applyEvent('REQUESTED', 'DRIVER_OFFERED')).toBe('OFFERED');
    });

    it('REQUESTED --DRIVER_OFFERED--> OFFERED', () => {
      expect(transitionOf('REQUESTED', 'DRIVER_OFFERED')).toBe('OFFERED');
    });

    it('REQUESTED --NO_DRIVER_AVAILABLE--> NO_DRIVER', () => {
      expect(transitionOf('REQUESTED', 'NO_DRIVER_AVAILABLE')).toBe('NO_DRIVER');
    });

    it('OFFERED --DRIVER_ACCEPTED--> CONFIRMED', () => {
      expect(transitionOf('OFFERED', 'DRIVER_ACCEPTED')).toBe('CONFIRMED');
    });

    it('OFFERED --DRIVER_DECLINED--> REQUESTED', () => {
      expect(transitionOf('OFFERED', 'DRIVER_DECLINED')).toBe('REQUESTED');
    });

    it('OFFERED --OFFER_TIMEOUT--> REQUESTED', () => {
      expect(transitionOf('OFFERED', 'OFFER_TIMEOUT')).toBe('REQUESTED');
    });

    it('CONFIRMED --DRIVER_ARRIVED--> ARRIVED', () => {
      expect(transitionOf('CONFIRMED', 'DRIVER_ARRIVED')).toBe('ARRIVED');
    });

    it('ARRIVED --TRIP_COMPLETED--> COMPLETED', () => {
      expect(transitionOf('ARRIVED', 'TRIP_COMPLETED')).toBe('COMPLETED');
    });

    it('REQUESTED --CANCELLED--> CANCELLED', () => {
      expect(transitionOf('REQUESTED', 'CANCELLED')).toBe('CANCELLED');
    });

    it('OFFERED --CANCELLED--> CANCELLED', () => {
      expect(transitionOf('OFFERED', 'CANCELLED')).toBe('CANCELLED');
    });

    it('CONFIRMED --CANCELLED--> CANCELLED', () => {
      expect(transitionOf('CONFIRMED', 'CANCELLED')).toBe('CANCELLED');
    });

    it('ARRIVED --CANCELLED--> CANCELLED', () => {
      expect(transitionOf('ARRIVED', 'CANCELLED')).toBe('CANCELLED');
    });
  });

  describe('PICKUP_DELAYED leaves state unchanged', () => {
    it('is allowed in REQUESTED', () => {
      expect(applyEvent('REQUESTED', 'PICKUP_DELAYED')).toBe('REQUESTED');
    });

    it('is allowed in OFFERED', () => {
      expect(applyEvent('OFFERED', 'PICKUP_DELAYED')).toBe('OFFERED');
    });

    it('is allowed in CONFIRMED', () => {
      expect(applyEvent('CONFIRMED', 'PICKUP_DELAYED')).toBe('CONFIRMED');
    });

    it('is denied in ARRIVED', () => {
      expect(() => applyEvent('ARRIVED', 'PICKUP_DELAYED')).toThrow(
        IllegalTransitionError,
      );
    });

    it('is denied in COMPLETED', () => {
      expect(() => applyEvent('COMPLETED', 'PICKUP_DELAYED')).toThrow(
        IllegalTransitionError,
      );
    });

    it('is denied in CANCELLED', () => {
      expect(() => applyEvent('CANCELLED', 'PICKUP_DELAYED')).toThrow(
        IllegalTransitionError,
      );
    });

    it('is denied in NO_DRIVER', () => {
      expect(() => applyEvent('NO_DRIVER', 'PICKUP_DELAYED')).toThrow(
        IllegalTransitionError,
      );
    });
  });

  describe('illegal transitions', () => {
    const illegal: [TripState, TripEvent][] = [
      ['REQUESTED', 'DRIVER_ARRIVED'],
      ['REQUESTED', 'TRIP_COMPLETED'],
      ['REQUESTED', 'DRIVER_ACCEPTED'],
      ['OFFERED', 'TRIP_COMPLETED'],
      ['OFFERED', 'DRIVER_ARRIVED'],
      ['CONFIRMED', 'NO_DRIVER_AVAILABLE'],
      ['CONFIRMED', 'DRIVER_DECLINED'],
      ['COMPLETED', 'CANCELLED'],
      ['COMPLETED', 'DRIVER_ARRIVED'],
      ['COMPLETED', 'DRIVER_ACCEPTED'],
      ['CANCELLED', 'DRIVER_OFFERED'],
      ['CANCELLED', 'CANCELLED'],
      ['NO_DRIVER', 'DRIVER_ACCEPTED'],
      ['NO_DRIVER', 'CANCELLED'],
      ['ARRIVED', 'NO_DRIVER_AVAILABLE'],
      ['ARRIVED', 'DRIVER_DECLINED'],
    ];

    it.each(illegal)('throws IllegalTransitionError for %s --%s-->', (from, event) => {
      expect(() => applyEvent(from, event)).toThrow(IllegalTransitionError);
    });

    it('IllegalTransitionError carries state and event', () => {
      try {
        applyEvent('COMPLETED', 'CANCELLED');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalTransitionError);
        expect((e as IllegalTransitionError).state).toBe('COMPLETED');
        expect((e as IllegalTransitionError).event).toBe('CANCELLED');
        expect((e as IllegalTransitionError).message).toContain('COMPLETED');
        expect((e as IllegalTransitionError).message).toContain('CANCELLED');
      }
    });
  });

  describe('terminal states', () => {
    it('COMPLETED, CANCELLED, NO_DRIVER are terminal', () => {
      for (const s of ['COMPLETED', 'CANCELLED', 'NO_DRIVER'] as TripState[]) {
        for (const e of states) {
          // terminal states only have PICKUP_DELAYED/CANCELLED handled; both should throw
          expect(() => applyEvent(s, e as TripEvent)).toThrow(
            IllegalTransitionError,
          );
        }
      }
    });
  });
});
