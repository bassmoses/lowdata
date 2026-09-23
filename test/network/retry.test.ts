import { afterEach, describe, expect, it, vi } from 'vitest';
import { LowdataRequestError } from '../../src/network/errors.js';
import {
  attemptWithRetry,
  defaultRetryOn,
  isRetryableStatus,
  parseRetryAfterMs,
} from '../../src/network/retry.js';

const FAST_RETRY = { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, jitter: 'none' as const };

function jsonResponse(status: number): Response {
  return new Response(null, { status });
}

describe('attemptWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the response immediately on success, without retrying', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const response = await attemptWithRetry({ url: '/x', retryConfig: FAST_RETRY });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns non-retryable error responses (e.g. 404) without retrying', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404));
    vi.stubGlobal('fetch', fetchMock);

    const response = await attemptWithRetry({ url: '/x', retryConfig: FAST_RETRY });
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 and eventually succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls < 3 ? jsonResponse(503) : jsonResponse(200);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await attemptWithRetry({ url: '/x', retryConfig: FAST_RETRY });
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('throws LowdataRequestError once retries are exhausted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      attemptWithRetry({ url: '/x', retryConfig: { ...FAST_RETRY, maxRetries: 2 } }),
    ).rejects.toBeInstanceOf(LowdataRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it('retries a thrown network error and recovers', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('network down');
      return jsonResponse(200);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await attemptWithRetry({ url: '/x', retryConfig: FAST_RETRY });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('honors Retry-After on a 429 instead of the computed backoff', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(null, { status: 429, headers: { 'Retry-After': '0' } });
      }
      return jsonResponse(200);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await attemptWithRetry({ url: '/x', retryConfig: FAST_RETRY });
    expect(response.status).toBe(200);
  });

  it('stops retrying immediately when the caller aborts, and rethrows without queuing semantics', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = attemptWithRetry({
      url: '/x',
      signal: controller.signal,
      retryConfig: FAST_RETRY,
    });
    controller.abort();

    await expect(promise).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when shouldContinue() reports false (e.g. connection dropped)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      attemptWithRetry({ url: '/x', retryConfig: FAST_RETRY, shouldContinue: () => false }),
    ).rejects.toBeInstanceOf(LowdataRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately, without a LowdataRequestError, if the signal is already aborted by the time a retryable response is ready to sleep before its retry', async () => {
    const controller = new AbortController();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const promise = attemptWithRetry({
      url: '/x',
      signal: controller.signal,
      retryConfig: { ...FAST_RETRY, baseDelayMs: 50, maxDelayMs: 50 },
    });

    // Abort while the first attempt's fetch() is still pending, then let it resolve with a
    // retryable status. By the time the retry loop reaches its backoff sleep(), the signal is
    // already aborted — sleep() must reject synchronously instead of waiting out the delay.
    controller.abort();
    resolveFetch(jsonResponse(503));

    await expect(promise).rejects.toBeDefined();
    await expect(promise).rejects.not.toBeInstanceOf(LowdataRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never got to a second attempt
  });

  it('stops backoff and rejects when the caller aborts mid-wait, during a retry backoff delay', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => jsonResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const promise = attemptWithRetry({
      url: '/x',
      signal: controller.signal,
      retryConfig: { ...FAST_RETRY, baseDelayMs: 200, maxDelayMs: 200 },
    });

    // Let the first attempt fail and enter its backoff sleep, then abort well before the 200ms
    // delay elapses — exercises sleep()'s 'abort' event listener, not its already-aborted check.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(promise).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); // aborted during backoff — never reached a retry
  });
});

describe('parseRetryAfterMs', () => {
  it('parses a Retry-After header expressed as an HTTP date into a millisecond delay', () => {
    const response = new Response(null, {
      headers: { 'Retry-After': new Date(Date.now() + 5000).toUTCString() },
    });
    const ms = parseRetryAfterMs(response);
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it('clamps a past HTTP-date Retry-After to 0 rather than a negative delay', () => {
    const response = new Response(null, {
      headers: { 'Retry-After': new Date(Date.now() - 5000).toUTCString() },
    });
    expect(parseRetryAfterMs(response)).toBe(0);
  });

  it('returns undefined for a Retry-After header that is neither a valid number nor a valid date', () => {
    const response = new Response(null, { headers: { 'Retry-After': 'not-a-valid-value' } });
    expect(parseRetryAfterMs(response)).toBeUndefined();
  });

  it('returns undefined when there is no Retry-After header at all', () => {
    const response = new Response(null);
    expect(parseRetryAfterMs(response)).toBeUndefined();
  });
});

describe('isRetryableStatus / defaultRetryOn', () => {
  it('classifies retryable vs. non-retryable statuses', () => {
    expect(isRetryableStatus(500)).toBe(false);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('retries network errors, timeouts, and retryable statuses; not other statuses', () => {
    expect(defaultRetryOn(new LowdataRequestError('x', { status: 404, attempt: 0 }))).toBe(false);
    expect(defaultRetryOn(new LowdataRequestError('x', { status: 503, attempt: 0 }))).toBe(true);
    expect(defaultRetryOn(new LowdataRequestError('x', { isNetworkError: true, attempt: 0 }))).toBe(
      true,
    );
    expect(defaultRetryOn(new LowdataRequestError('x', { isTimeout: true, attempt: 0 }))).toBe(
      true,
    );
  });
});
