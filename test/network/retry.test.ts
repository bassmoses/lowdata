import { afterEach, describe, expect, it, vi } from 'vitest';
import { LowdataRequestError } from '../../src/network/errors.js';
import { attemptWithRetry, defaultRetryOn, isRetryableStatus } from '../../src/network/retry.js';

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
