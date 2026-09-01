import { describe, expect, it, vi } from 'vitest';
import { computeBackoffDelay } from '../../src/core/backoff.js';
import { DEFAULT_RETRY_CONFIG } from '../../src/core/types.js';

describe('computeBackoffDelay', () => {
  it('returns a deterministic exponential delay with jitter "none"', () => {
    const config = {
      ...DEFAULT_RETRY_CONFIG,
      jitter: 'none' as const,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    };
    expect(computeBackoffDelay(0, config)).toBe(100);
    expect(computeBackoffDelay(1, config)).toBe(200);
    expect(computeBackoffDelay(2, config)).toBe(400);
    expect(computeBackoffDelay(3, config)).toBe(800);
  });

  it('caps the delay at maxDelayMs', () => {
    const config = {
      ...DEFAULT_RETRY_CONFIG,
      jitter: 'none' as const,
      baseDelayMs: 1000,
      maxDelayMs: 3000,
    };
    expect(computeBackoffDelay(10, config)).toBe(3000);
  });

  it('"full" jitter scales the exponential delay by Math.random()', () => {
    const config = {
      ...DEFAULT_RETRY_CONFIG,
      jitter: 'full' as const,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    };
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(computeBackoffDelay(2, config)).toBe(200); // exp = 400, 0.5 * 400
    vi.restoreAllMocks();
  });

  it('"equal" jitter keeps the delay between exp/2 and exp', () => {
    const config = {
      ...DEFAULT_RETRY_CONFIG,
      jitter: 'equal' as const,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    };
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(computeBackoffDelay(2, config)).toBe(300); // exp = 400, 200 + 0.5*200
    vi.restoreAllMocks();
  });

  it('treats a negative attempt as attempt 0', () => {
    const config = {
      ...DEFAULT_RETRY_CONFIG,
      jitter: 'none' as const,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    };
    expect(computeBackoffDelay(-5, config)).toBe(100);
  });
});
