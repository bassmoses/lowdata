import type { RetryBackoffConfig } from './types.js';

/**
 * Exponential backoff with jitter.
 *
 * `attempt` is 0-indexed (0 = delay before the first retry, after the initial try failed).
 * Jitter strategies:
 *  - 'full':  Random(0, exp)              — spreads retries the most, best for avoiding a
 *                                            thundering herd when many clients reconnect at once.
 *  - 'equal': exp/2 + Random(0, exp/2)    — keeps delays closer to the exponential curve while
 *                                            still avoiding perfect synchronization.
 *  - 'none':  exp                          — deterministic, useful mainly for tests.
 */
export function computeBackoffDelay(attempt: number, config: RetryBackoffConfig): number {
  const safeAttempt = Math.max(0, attempt);
  const exp = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** safeAttempt);

  switch (config.jitter) {
    case 'none':
      return exp;
    case 'equal':
      return exp / 2 + Math.random() * (exp / 2);
    case 'full':
    default:
      return Math.random() * exp;
  }
}
