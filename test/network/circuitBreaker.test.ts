import { describe, expect, it } from 'vitest';
import { CircuitBreaker, defaultBreakerKey } from '../../src/network/circuitBreaker.js';

describe('defaultBreakerKey', () => {
  it('groups by URL origin', () => {
    expect(defaultBreakerKey('https://api.example.com/v1/orders')).toBe('https://api.example.com');
    expect(defaultBreakerKey('https://api.example.com/v1/customers')).toBe(
      'https://api.example.com',
    );
  });

  it('falls back to the literal string for an unparseable (relative) URL', () => {
    expect(defaultBreakerKey('/v1/orders')).toBe('/v1/orders');
  });
});

describe('CircuitBreaker', () => {
  it('stays closed below the failure threshold', () => {
    const breaker = new CircuitBreaker({ threshold: 3 });
    breaker.recordFailure('https://api.example.com/a');
    breaker.recordFailure('https://api.example.com/a');
    expect(breaker.isOpen('https://api.example.com/a')).toBe(false);
  });

  it('opens after reaching the threshold, and stays open within the cooldown', () => {
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    breaker.recordFailure('https://api.example.com/a');
    breaker.recordFailure('https://api.example.com/a');
    expect(breaker.isOpen('https://api.example.com/a')).toBe(true);
  });

  it('groups failures by origin, not by full URL', () => {
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    breaker.recordFailure('https://api.example.com/a');
    breaker.recordFailure('https://api.example.com/b');
    expect(breaker.isOpen('https://api.example.com/anything')).toBe(true);
  });

  it('a success resets the consecutive-failure count', () => {
    const breaker = new CircuitBreaker({ threshold: 2 });
    breaker.recordFailure('https://api.example.com/a');
    breaker.recordSuccess('https://api.example.com/a');
    breaker.recordFailure('https://api.example.com/a');
    expect(breaker.isOpen('https://api.example.com/a')).toBe(false);
  });

  it('half-opens after the cooldown elapses, allowing one trial through', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 10 });
    breaker.recordFailure('https://api.example.com/a');
    expect(breaker.isOpen('https://api.example.com/a')).toBe(true);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(breaker.isOpen('https://api.example.com/a')).toBe(false); // half-open: one trial allowed
        resolve();
      }, 20);
    });
  });

  it('half-open state blocks a second caller once the one trial slot is claimed', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 10 });
    breaker.recordFailure('https://api.example.com/a');

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // First isOpen() call past the cooldown claims the trial (false = allowed through).
        expect(breaker.isOpen('https://api.example.com/a')).toBe(false);
        // A second caller for the same origin — e.g. a concurrent item under syncConcurrency > 1,
        // or the same item's own later re-check — must NOT also get a trial slot.
        expect(breaker.isOpen('https://api.example.com/a')).toBe(true);
        resolve();
      }, 20);
    });
  });

  it('recordFailure() returns true only on the transition into "open", not on every failure after', () => {
    const breaker = new CircuitBreaker({ threshold: 2 });
    expect(breaker.recordFailure('https://api.example.com/a')).toBe(false); // 1st — below threshold
    expect(breaker.recordFailure('https://api.example.com/a')).toBe(true); // 2nd — crosses it
    expect(breaker.recordFailure('https://api.example.com/a')).toBe(false); // already open
  });

  it('recordFailure() reports true again if a half-open trial itself fails, re-opening the breaker', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 10 });
    expect(breaker.recordFailure('https://api.example.com/a')).toBe(true); // opens

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(breaker.isOpen('https://api.example.com/a')).toBe(false); // claims the trial
        expect(breaker.recordFailure('https://api.example.com/a')).toBe(true); // trial failed — re-opens
        resolve();
      }, 20);
    });
  });

  it('supports a custom keyBy grouping (e.g. by full URL instead of origin)', () => {
    const breaker = new CircuitBreaker({ threshold: 1, keyBy: (url) => url });
    breaker.recordFailure('https://api.example.com/a');
    expect(breaker.isOpen('https://api.example.com/a')).toBe(true);
    expect(breaker.isOpen('https://api.example.com/b')).toBe(false);
  });
});
