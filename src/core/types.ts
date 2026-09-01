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
