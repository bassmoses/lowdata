import { computeBackoffDelay } from '../core/backoff.js';
import { combineSignals } from '../core/abortAny.js';
import { DEFAULT_RETRY_CONFIG, type RetryBackoffConfig } from '../core/types.js';
import { LowdataRequestError } from './errors.js';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Default retry policy: retry network errors, timeouts, and 429/502/503/504; fail fast otherwise. */
export function defaultRetryOn(error: LowdataRequestError): boolean {
  if (error.isNetworkError || error.isTimeout) return true;
  return typeof error.status === 'number' && RETRYABLE_STATUS.has(error.status);
}

export function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('lowdata: aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('lowdata: aborted'));
      },
      { once: true },
    );
  });
}

export interface AttemptWithRetryOptions {
  url: string;
  init?: RequestInit;
  retryConfig?: Partial<RetryBackoffConfig>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called after each failed attempt; returning `false` stops retrying immediately (e.g. connection dropped). */
  shouldContinue?: () => boolean;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Perform a fetch with automatic retry + exponential backoff + jitter. Resolves with the
 * `Response` as soon as it's non-retryable (2xx..4xx outside the retryable set) — callers still
 * check `response.ok` themselves, matching native `fetch` semantics. Throws `LowdataRequestError`
 * only once retries are exhausted or `shouldContinue()` returns false.
 */
export async function attemptWithRetry(options: AttemptWithRetryOptions): Promise<Response> {
  const config: RetryBackoffConfig = { ...DEFAULT_RETRY_CONFIG, ...options.retryConfig };
  const retryOn = config.retryOn ?? defaultRetryOn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: LowdataRequestError | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combined = combineSignals([options.signal, timeoutController.signal]);

    try {
      const response = await fetch(options.url, { ...options.init, signal: combined.signal });
      clearTimeout(timer);
      combined.dispose();

      if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
        return response;
      }

      lastError = new LowdataRequestError(`Request failed with status ${response.status}`, {
        status: response.status,
        attempt,
        retryAfterMs: parseRetryAfterMs(response),
      });
    } catch (cause) {
      clearTimeout(timer);
      combined.dispose();

      if (options.signal?.aborted) {
        // Caller explicitly cancelled — never retry, never fall back to queueing.
        throw cause;
      }

      const isTimeout = timeoutController.signal.aborted;
      lastError = new LowdataRequestError(
        isTimeout ? 'Request timed out' : 'Network request failed',
        { isNetworkError: !isTimeout, isTimeout, attempt, cause },
      );
    }

    const isLastAttempt = attempt === config.maxRetries;
    const continueRetrying = options.shouldContinue ? options.shouldContinue() : true;
    if (isLastAttempt || !continueRetrying || !retryOn(lastError, attempt)) {
      throw lastError;
    }

    const delay = lastError.retryAfterMs ?? computeBackoffDelay(attempt, config);
    await sleep(Math.min(delay, config.maxDelayMs), options.signal);
  }

  // Unreachable: the loop always returns or throws, but keeps TypeScript's control-flow happy.
  throw lastError ?? new LowdataRequestError('Request failed', { attempt: config.maxRetries });
}
