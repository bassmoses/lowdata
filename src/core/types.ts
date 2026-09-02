/** Coarse connection quality bucket used throughout lowdata. */
export type ConnectionQuality = 'online' | 'slow' | 'offline';

/** Snapshot of what lowdata currently knows about the network. */
export interface ConnectionInfo {
  quality: ConnectionQuality;
  online: boolean;
  /** Populated only where the Network Information API is available (Chromium browsers). */
  effectiveType?: '4g' | '3g' | '2g' | 'slow-2g';
  downlinkMbps?: number;
  rttMs?: number;
  saveData?: boolean;
}

export type ConnectionListener = (info: ConnectionInfo) => void;
/** Call to stop listening. */
export type Unsubscribe = () => void;

export type RequestPriority = 'high' | 'normal' | 'low';

export type JitterStrategy = 'full' | 'equal' | 'none';

export interface RetryBackoffConfig {
  /** Maximum number of retry attempts after the initial try. Default: 8. */
  maxRetries: number;
  /** Base delay in ms used by the exponential backoff formula. Default: 500. */
  baseDelayMs: number;
  /** Upper bound for any single computed delay, in ms. Default: 30_000. */
  maxDelayMs: number;
  /** Jitter strategy applied on top of the exponential delay. Default: 'full'. */
  jitter: JitterStrategy;
  /** Decide whether a failed attempt should be retried. Defaults to `defaultRetryOn`. */
  retryOn?: (error: LowdataRequestError, attempt: number) => boolean;
}

/** Error thrown/recorded for a failed request attempt, carrying retry-relevant metadata. */
export interface LowdataRequestError extends Error {
  status?: number;
  isNetworkError: boolean;
  isTimeout: boolean;
  attempt: number;
  retryAfterMs?: number;
}

export const DEFAULT_RETRY_CONFIG: RetryBackoffConfig = {
  maxRetries: 8,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 'full',
};

/**
 * Where an internal, otherwise-silent failure originated:
 *  - `'db-open'`: IndexedDB itself couldn't be opened (SSR, unsupported/locked-down browser) —
 *    persistence is now permanently disabled for this session; lowdata falls back to an
 *    in-memory queue/draft store.
 *  - `'db-operation'`: a single IndexedDB operation failed (e.g. a transient
 *    `QuotaExceededError`, a blocked transaction) — persistence is still available; only that
 *    one call fell back to memory.
 *  - `'sync'`: the background sync loop hit an error outside of a single queued item's own
 *    retry accounting (e.g. it couldn't acquire the shared database or the cross-tab lock).
 */
export type LowdataErrorScope = 'db-open' | 'db-operation' | 'sync';

/**
 * Optional escape hatch for otherwise-silent internal failures. lowdata deliberately never lets
 * these throw — a failed background sync or a degraded-to-memory fallback shouldn't crash the
 * host app — but a production app still needs a way to *see* it happened (log it, alert on it),
 * rather than it vanishing into a single `console.warn`.
 */
export type LowdataErrorHandler = (error: unknown, context: { scope: LowdataErrorScope }) => void;
