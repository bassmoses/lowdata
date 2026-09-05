/**
 * Per-endpoint circuit breaker for the sync drain loop. Without this, N queued items all targeting
 * one persistently-down host each retry independently (with jitter, so they don't perfectly
 * synchronize — but they also don't coordinate): a host that's genuinely down still gets hit by
 * every queued item, every drain cycle. The breaker tracks consecutive failures per key (default:
 * URL origin) and, once a threshold is hit, skips items in that group entirely for a cooldown
 * window rather than sending — and failing — every one of them.
 */
export interface CircuitBreakerConfig {
  /** Consecutive failures before the breaker opens for a given key. Default 5. */
  threshold?: number;
  /** How long the breaker stays open before allowing a single trial request through. Default 30s. */
  cooldownMs?: number;
  /** Groups requests into breaker keys. Default: the request's URL origin (falls back to the full URL if it isn't parseable as an absolute URL). */
  keyBy?: (url: string) => string;
}

type BreakerState = 'closed' | 'open' | 'half-open';

interface BreakerRecord {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt?: number;
  /** Set the instant a half-open breaker lets its one trial request through; cleared on that trial's outcome. */
  trialInFlight: boolean;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;

export function defaultBreakerKey(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url; // relative URL or otherwise unparseable — group by the literal string instead
  }
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly keyBy: (url: string) => string;
  private records = new Map<string, BreakerRecord>();

  constructor(config: CircuitBreakerConfig = {}) {
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.keyBy = config.keyBy ?? defaultBreakerKey;
  }

  keyFor(url: string): string {
    return this.keyBy(url);
  }

  /**
   * `true` means "don't send this now". A `half-open` breaker (cooldown elapsed) lets exactly ONE
   * caller through as a trial, enforced here (not just documented): the first `isOpen()` call that
   * observes the elapsed cooldown flips to half-open AND claims the trial in the same call, so a
   * second concurrent item for the same origin — evaluated in the same `Array.filter()` pass, or
   * under `syncConcurrency > 1` — sees `trialInFlight` and stays blocked instead of also being let
   * through. That caller's outcome (`recordSuccess`/`recordFailure`) decides whether the breaker
   * closes or re-opens for another cooldown.
   */
  isOpen(url: string): boolean {
    const record = this.records.get(this.keyFor(url));
    if (!record || record.state === 'closed') return false;
    if (record.state === 'half-open') return record.trialInFlight; // trial already claimed — block
    // state === 'open'
    if (Date.now() - (record.openedAt ?? 0) >= this.cooldownMs) {
      record.state = 'half-open';
      record.trialInFlight = true;
      return false; // this caller *is* the trial
    }
    return true;
  }

  recordSuccess(url: string): void {
    this.records.delete(this.keyFor(url));
  }

  /**
   * Returns `true` only when *this* failure is what just transitioned the breaker into `'open'` —
   * so callers can fire a one-time "circuit just opened" notification without a second `isOpen()`
   * call. A second call would be actively wrong here: after this method flips a half-open breaker
   * back to `'open'`, `isOpen()` no longer distinguishes "was already open" from "just opened".
   */
  recordFailure(url: string): boolean {
    const key = this.keyFor(url);
    const record = this.records.get(key) ?? {
      state: 'closed' as const,
      consecutiveFailures: 0,
      trialInFlight: false,
    };
    const wasOpen = record.state === 'open';
    record.consecutiveFailures += 1;
    record.trialInFlight = false; // the trial (if this was one) has now resolved, one way or another
    if (record.consecutiveFailures >= this.threshold) {
      record.state = 'open';
      record.openedAt = Date.now();
    }
    this.records.set(key, record);
    return !wasOpen && record.state === 'open';
  }
}
