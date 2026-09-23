import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionMonitor } from '../../src/core/connection.js';
import { RequestQueue } from '../../src/network/queue.js';
import { SyncManager } from '../../src/network/sync.js';
import type { SyncManagerOptions } from '../../src/network/sync.js';
import type { SyncEvent } from '../../src/network/types.js';
import { openTestAdapter } from '../helpers/db.js';
import { makeQueueItem as makeItem } from '../helpers/queueItem.js';
import { waitForCondition } from '../helpers/wait.js';

function setup(
  dbName: string,
  retryConfig = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitter: 'none' as const },
  extra: Partial<SyncManagerOptions> = {},
) {
  const storage = openTestAdapter(dbName);
  const queue = new RequestQueue(storage);
  const connection = new ConnectionMonitor();
  const events: SyncEvent[] = [];
  const sync = new SyncManager({
    queue,
    connection,
    storage,
    syncConcurrency: 1,
    retryConfig,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { queue, connection, sync, events };
}

describe('SyncManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drains a pending item successfully, purges it, and emits item-success', async () => {
    const { queue, connection, sync, events } = setup(`sync-test-${Math.random()}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const item = await queue.add(makeItem());
    await sync.drain();

    // Successful items are purged (not retained as 'done') so a long-lived queue doesn't grow
    // unbounded — the terminal item is still observable via the emitted event.
    expect(await queue.get(item.id)).toBeUndefined();
    const successEvent = events.find((e) => e.type === 'item-success');
    expect(successEvent).toBeDefined();
    expect(successEvent?.type === 'item-success' && successEvent.item.status).toBe('done');
    expect(events.some((e) => e.type === 'item-start')).toBe(true);
    sync.destroy();
    connection.destroy();
  });

  it('does not capture the response body by default', async () => {
    const { queue, sync, events } = setup(`sync-test-capture-off-${Math.random()}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'ALREADY_SCANNED' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await queue.add(makeItem());
    await sync.drain();

    const successEvent = events.find((e) => e.type === 'item-success');
    expect(successEvent?.type === 'item-success' && successEvent.response).toBeUndefined();
    sync.destroy();
  });

  it('captures a parsed JSON response body on item-success when captureResponseBody is enabled', async () => {
    const { queue, sync, events } = setup(`sync-test-capture-json-${Math.random()}`, undefined, {
      captureResponseBody: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'ALREADY_SCANNED' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await queue.add(makeItem());
    await sync.drain();

    const successEvent = events.find((e) => e.type === 'item-success');
    expect(successEvent?.type === 'item-success' && successEvent.response).toEqual({
      status: 200,
      body: { status: 'ALREADY_SCANNED' },
    });
    sync.destroy();
  });

  it('captures the response on item-failed too, when the server actually responded (not a network error)', async () => {
    const { queue, sync, events } = setup(
      `sync-test-capture-failed-${Math.random()}`,
      { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
      { captureResponseBody: true },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'invalid ticket' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await queue.add(makeItem());
    await sync.drain();

    const failedEvent = events.find((e) => e.type === 'item-failed');
    expect(failedEvent?.type === 'item-failed' && failedEvent.response).toEqual({
      status: 400,
      body: { error: 'invalid ticket' },
    });
    sync.destroy();
  });

  it('falls back to raw text for a non-JSON response, and skips the body entirely past the size cap', async () => {
    const { queue, sync, events } = setup(`sync-test-capture-text-${Math.random()}`, undefined, {
      captureResponseBody: true,
      captureResponseBodyMaxBytes: 10,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('this response body is way over ten bytes', { status: 200 })),
    );

    await queue.add(makeItem());
    await sync.drain();

    const successEvent = events.find((e) => e.type === 'item-success');
    // Over the 10-byte cap — only status is captured, not the body.
    expect(successEvent?.type === 'item-success' && successEvent.response).toEqual({ status: 200 });
    sync.destroy();
  });

  it('never captures a response for a genuine network error — there is no Response to read', async () => {
    const { queue, sync, events } = setup(
      `sync-test-capture-network-error-${Math.random()}`,
      { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
      { captureResponseBody: true },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await queue.add(makeItem());
    await sync.drain();

    const failedEvent = events.find((e) => e.type === 'item-failed');
    expect(failedEvent?.type === 'item-failed' && failedEvent.response).toBeUndefined();
    sync.destroy();
  });

  it('a per-item captureResponseBody overrides the client default in both directions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'ALREADY_SCANNED' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    // Client default ON, this one item opts out.
    {
      const { queue, sync, events } = setup(
        `sync-test-capture-item-off-${Math.random()}`,
        undefined,
        { captureResponseBody: true },
      );
      await queue.add(makeItem({ captureResponseBody: false }));
      await sync.drain();
      const successEvent = events.find((e) => e.type === 'item-success');
      expect(successEvent?.type === 'item-success' && successEvent.response).toBeUndefined();
      sync.destroy();
    }

    // Client default OFF, this one item opts in.
    {
      const { queue, sync, events } = setup(`sync-test-capture-item-on-${Math.random()}`);
      await queue.add(makeItem({ captureResponseBody: true }));
      await sync.drain();
      const successEvent = events.find((e) => e.type === 'item-success');
      expect(successEvent?.type === 'item-success' && successEvent.response).toEqual({
        status: 200,
        body: { status: 'ALREADY_SCANNED' },
      });
      sync.destroy();
    }
  });

  it('captures the raw text body for a non-JSON, under-the-cap response', async () => {
    const { queue, sync, events } = setup(`sync-test-capture-text-plain-${Math.random()}`, undefined, {
      captureResponseBody: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('plain text ok', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
    );

    await queue.add(makeItem());
    await sync.drain();

    const successEvent = events.find((e) => e.type === 'item-success');
    expect(successEvent?.type === 'item-success' && successEvent.response).toEqual({
      status: 200,
      body: 'plain text ok',
    });
    sync.destroy();
  });

  it('falls back to the raw text body when a "json" content-type response is not actually valid JSON', async () => {
    const { queue, sync, events } = setup(`sync-test-capture-bad-json-${Math.random()}`, undefined, {
      captureResponseBody: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('not actually json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await queue.add(makeItem());
    await sync.drain();

    const successEvent = events.find((e) => e.type === 'item-success');
    expect(successEvent?.type === 'item-success' && successEvent.response).toEqual({
      status: 200,
      body: 'not actually json',
    });
    sync.destroy();
  });

  it('captures just the status, without throwing, when reading the response body itself fails', async () => {
    const { queue, sync, events } = setup(
      `sync-test-capture-body-read-fails-${Math.random()}`,
      undefined,
      { captureResponseBody: true },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = new Response('irrelevant', { status: 200 });
        vi.spyOn(response, 'text').mockRejectedValue(new Error('stream errored'));
        return response;
      }),
    );

    await queue.add(makeItem());
    await expect(sync.drain()).resolves.toBeUndefined();

    const successEvent = events.find((e) => e.type === 'item-success');
    expect(successEvent?.type === 'item-success' && successEvent.response).toEqual({ status: 200 });
    sync.destroy();
  });

  it("attaches the item's idempotencyKey as an Idempotency-Key header when sending", async () => {
    const { queue, sync } = setup(`sync-test-idem-${Math.random()}`);
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentHeaders.push(init?.headers as Record<string, string> | undefined);
        return new Response(null, { status: 200 });
      }),
    );

    await queue.add(makeItem({ idempotencyKey: 'idem-123' }));
    await sync.drain();

    expect(sentHeaders[0]?.['Idempotency-Key']).toBe('idem-123');
    sync.destroy();
  });

  it('calls resolveHeaders() fresh on every send attempt and uses its latest result, not a value frozen at enqueue time', async () => {
    let token = 'stale-token';
    // A large baseDelayMs keeps the rescheduled item's nextAttemptAt safely in the future, so the
    // retry only happens once we force it below — same convention as the backoff test above.
    const { queue, sync } = setup(
      `sync-test-resolve-headers-${Math.random()}`,
      { maxRetries: 2, baseDelayMs: 60_000, maxDelayMs: 60_000, jitter: 'none' },
      { resolveHeaders: () => ({ Authorization: `Bearer ${token}` }) },
    );
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentHeaders.push(init?.headers as Record<string, string> | undefined);
        // Fails the first attempt with a retryable status, succeeds once a fresh token is in hand —
        // proving resolveHeaders() is re-asked on the retry, not just used once at first send.
        return sentHeaders.length === 1
          ? new Response(null, { status: 503 })
          : new Response(null, { status: 200 });
      }),
    );

    const item = await queue.add(makeItem({ headers: { Authorization: 'Bearer stale-token' } }));
    await sync.drain();
    expect(sentHeaders[0]?.['Authorization']).toBe('Bearer stale-token');

    token = 'fresh-token';
    await queue.update({ ...(await queue.get(item.id))!, nextAttemptAt: Date.now() });
    await sync.drain();
    expect(sentHeaders[1]?.['Authorization']).toBe('Bearer fresh-token');

    sync.destroy();
  });

  it('layers resolveHeaders() under item.headers and Idempotency-Key on top of both', async () => {
    const { queue, sync } = setup(
      `sync-test-resolve-headers-layering-${Math.random()}`,
      undefined,
      { resolveHeaders: () => ({ Authorization: 'Bearer fresh', 'X-From-Resolver': '1' }) },
    );
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentHeaders.push(init?.headers as Record<string, string> | undefined);
        return new Response(null, { status: 200 });
      }),
    );

    await queue.add(
      makeItem({
        headers: { Authorization: 'Bearer stale', 'X-Static': 'yes' },
        idempotencyKey: 'idem-456',
      }),
    );
    await sync.drain();

    expect(sentHeaders[0]).toEqual({
      Authorization: 'Bearer fresh', // resolveHeaders() wins over item.headers
      'X-Static': 'yes', // untouched item.headers pass through
      'X-From-Resolver': '1',
      'Idempotency-Key': 'idem-456', // still layered on top of everything
    });
    sync.destroy();
  });

  it('treats a resolveHeaders() rejection as a retryable failure, without ever calling fetch()', async () => {
    let shouldFail = true;
    // Large baseDelayMs, same convention as the backoff test above — the retry is forced explicitly
    // below rather than raced against a real (tiny) backoff delay.
    const { queue, sync, events } = setup(
      `sync-test-resolve-headers-throws-${Math.random()}`,
      { maxRetries: 2, baseDelayMs: 60_000, maxDelayMs: 60_000, jitter: 'none' },
      {
        resolveHeaders: () => {
          if (shouldFail) throw new Error('token refresh failed');
          return { Authorization: 'Bearer recovered' };
        },
      },
    );
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const item = await queue.add(makeItem());
    await sync.drain();

    expect(fetchMock).not.toHaveBeenCalled();
    const failedEvent = events.find((e) => e.type === 'item-failed');
    expect(failedEvent?.type === 'item-failed' && failedEvent.willRetry).toBe(true);
    expect(failedEvent?.type === 'item-failed' && failedEvent.item.lastError).toContain(
      'Failed to resolve headers before sending',
    );

    shouldFail = false;
    await queue.update({ ...(await queue.get(item.id))!, nextAttemptAt: Date.now() });
    await sync.drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue.list()).toHaveLength(0); // succeeded once the resolver recovered, and was purged

    sync.destroy();
  });

  it('does not double-send when drain() is called twice concurrently in the same tick', async () => {
    const { queue, sync } = setup(`sync-test-concurrent-${Math.random()}`);
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        return new Response(null, { status: 200 });
      }),
    );

    await queue.add(makeItem());
    // Two drain() calls issued in the same tick (e.g. two client.fetch() calls both triggering
    // notifyEnqueued()) must not both pass the re-entrancy guard and send the item twice.
    await Promise.all([sync.drain(), sync.drain()]);

    expect(callCount).toBe(1);
    sync.destroy();
  });

  it("caps a queued item's Retry-After-driven reschedule at retryConfig.maxDelayMs", async () => {
    const { queue, sync } = setup(`sync-test-retry-after-${Math.random()}`, {
      maxRetries: 2,
      baseDelayMs: 1,
      maxDelayMs: 5_000,
      jitter: 'none',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } })),
    );

    const item = await queue.add(makeItem());
    const before = Date.now();
    await sync.drain();

    const updated = await queue.get(item.id);
    expect(updated?.status).toBe('pending');
    // The server asked for a 3600s (3,600,000ms) Retry-After, but retryConfig.maxDelayMs caps it
    // at 5s — matching how the live-retry path (retry.ts) caps the same header. The slack here is
    // generous (2s) to absorb real scheduling jitter (storage round-trips, lock acquisition)
    // without weakening the assertion: an uncapped regression would overshoot by ~3,595,000ms, not 2,000ms.
    expect(updated!.nextAttemptAt - before).toBeLessThanOrEqual(7_000);
    sync.destroy();
  });

  it('reschedules a failing item with backoff, then marks it failed after exhausting retries', async () => {
    // A large baseDelayMs keeps the rescheduled item's nextAttemptAt safely in the future, so each
    // drain() call below processes it exactly once instead of the loop immediately re-draining it
    // within the same call (which is what a tiny baseDelayMs would otherwise correctly do).
    const { queue, sync, events } = setup(`sync-test-fail-${Math.random()}`, {
      maxRetries: 2,
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
      jitter: 'none',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    const item = await queue.add(makeItem());
    await sync.drain();

    let updated = await queue.get(item.id);
    expect(updated?.status).toBe('pending');
    expect(updated?.attempts).toBe(1);

    await queue.update({ ...(await queue.get(item.id))!, nextAttemptAt: Date.now() });
    await sync.drain();
    await queue.update({ ...(await queue.get(item.id))!, nextAttemptAt: Date.now() });
    await sync.drain();

    updated = await queue.get(item.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.attempts).toBe(3);
    expect(events.some((e) => e.type === 'item-failed' && !e.willRetry)).toBe(true);
    sync.destroy();
  });

  it.each([400, 404, 500, 505, 511])(
    'marks a non-retryable %i response as failed, never as success',
    async (status) => {
      const { queue, sync, events } = setup(`sync-test-non-retryable-${status}-${Math.random()}`);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status })),
      );

      const item = await queue.add(makeItem());
      await sync.drain();

      // The exact bug this guards: response.ok is false and the status isn't in the small
      // retryable set (429/502/503/504) either — that must NOT be treated as delivered. Before
      // this fix it was purged as 'done' and reported as 'item-success'.
      const updated = await queue.get(item.id);
      expect(updated?.status).toBe('failed');
      expect(events.some((e) => e.type === 'item-success')).toBe(false);
      expect(
        events.some((e) => e.type === 'item-failed' && !e.willRetry && e.item.status === 'failed'),
      ).toBe(true);
      sync.destroy();
    },
  );

  it('emits items-blocked (reason: dependency) for a due item withheld by an unresolved dependency', async () => {
    const { queue, sync, events } = setup(`sync-test-blocked-dep-${Math.random()}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const now = Date.now();
    await queue.add(makeItem({ id: 'parent', nextAttemptAt: now }));
    await queue.add(makeItem({ id: 'child', dependsOn: ['parent'], nextAttemptAt: now }));
    await sync.drain();

    const blockedEvent = events.find(
      (e) => e.type === 'items-blocked' && e.reason === 'dependency',
    );
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.type === 'items-blocked' && blockedEvent.items.map((i) => i.id)).toEqual([
      'child',
    ]);
    sync.destroy();
  });

  it('emits items-blocked (reason: circuit-breaker) for an item withheld by an already-open breaker', async () => {
    const { queue, sync, events } = setup(
      `sync-test-blocked-breaker-${Math.random()}`,
      { maxRetries: 10, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
      { circuitBreaker: { threshold: 1, cooldownMs: 60_000 } },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    // First item trips the breaker open (threshold: 1).
    await queue.add(makeItem({ id: 'trips-it', url: 'https://api.example.com/a' }));
    await sync.drain();
    expect(events.some((e) => e.type === 'circuit-open')).toBe(true);

    // A second item enqueued *after* the breaker is already open gets no fresh 'circuit-open'
    // transition event — without 'items-blocked' it would be completely invisible.
    events.length = 0;
    await queue.add(makeItem({ id: 'newly-added', url: 'https://api.example.com/b' }));
    await sync.drain();

    const blockedEvent = events.find(
      (e) => e.type === 'items-blocked' && e.reason === 'circuit-breaker',
    );
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.type === 'items-blocked' && blockedEvent.items.map((i) => i.id)).toContain(
      'newly-added',
    );
    sync.destroy();
  });

  it('opens the circuit breaker after threshold consecutive failures against one origin, skipping further sends', async () => {
    const { queue, sync, events } = setup(
      `sync-test-breaker-${Math.random()}`,
      { maxRetries: 10, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
      { circuitBreaker: { threshold: 2, cooldownMs: 60_000 } },
    );
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls++;
        return new Response(null, { status: 503 });
      }),
    );

    await queue.add(makeItem({ id: 'a', url: 'https://api.example.com/a' }));
    await queue.add(makeItem({ id: 'b', url: 'https://api.example.com/b' }));
    await queue.add(makeItem({ id: 'c', url: 'https://api.example.com/c' }));

    // Drain repeatedly (each retry's nextAttemptAt is effectively "now" with baseDelayMs: 1): two
    // failures open the breaker for the shared origin, after which no further item against it is
    // ever sent — not "the third item specifically", since ordering among same-priority,
    // same-instant items isn't a contract this test should depend on.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await sync.drain();
    }

    expect(events.some((e) => e.type === 'circuit-open')).toBe(true);
    // Exactly 2 failures open the breaker (threshold: 2); the 3rd item's attempts stays at 0 —
    // wherever it landed in send order — and no drain() after that gets through at all.
    const [a, b, c] = await Promise.all([queue.get('a'), queue.get('b'), queue.get('c')]);
    const totalAttempts = (a?.attempts ?? 0) + (b?.attempts ?? 0) + (c?.attempts ?? 0);
    expect(totalAttempts).toBe(2);
    expect(fetchCalls).toBe(2);
    sync.destroy();
  });

  it('half-open state allows exactly one trial request even with multiple eligible items and syncConcurrency > 1', async () => {
    const { queue, sync } = setup(
      `sync-test-half-open-single-trial-${Math.random()}`,
      { maxRetries: 10, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
      // cooldownMs is deliberately generous (not a tight ~10ms) relative to real overhead within a
      // single drain() loop (several selectEligible()/storage round-trips per iteration): a thin
      // margin here previously let the *same* drain() call cross the cooldown a second time after
      // the trial's own failure re-opened the breaker, letting an unrelated extra fetch through and
      // making this test's pass/fail depend on incidental timing rather than the guarantee itself.
      { syncConcurrency: 5, circuitBreaker: { threshold: 1, cooldownMs: 500 } },
    );
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls++;
        return new Response(null, { status: 503 }); // keeps failing — breaker re-opens after the trial too
      }),
    );

    // Trip the breaker open (threshold: 1).
    await queue.add(makeItem({ id: 'a', url: 'https://api.example.com/a' }));
    await sync.drain();
    expect(fetchCalls).toBe(1);

    // Add several more items against the same origin while the breaker is open, then wait past
    // the cooldown so it goes half-open — with syncConcurrency: 5, a broken single-trial guard
    // would let all of them through at once instead of exactly one.
    await queue.add(makeItem({ id: 'b', url: 'https://api.example.com/b' }));
    await queue.add(makeItem({ id: 'c', url: 'https://api.example.com/c' }));
    await queue.add(makeItem({ id: 'd', url: 'https://api.example.com/d' }));
    await new Promise((r) => setTimeout(r, 550)); // past cooldownMs: 500
    await sync.drain();

    // Exactly one more fetch (the trial) — not up to 4 more.
    expect(fetchCalls).toBe(2);
    sync.destroy();
  });

  it('migrates a queue item whose schemaVersion is stale before sending it', async () => {
    const { queue, sync } = setup(`sync-test-migrate-${Math.random()}`, undefined, {
      schemaVersion: 2,
      migrateQueueItem: (item) => ({
        ...item,
        body: JSON.stringify({ migrated: true, was: item.body }),
      }),
    });
    let sentBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = init?.body;
        return new Response(null, { status: 200 });
      }),
    );

    await queue.add(makeItem({ schemaVersion: 1, body: '"old-shape"' }));
    await sync.drain();

    expect(sentBody).toBe(JSON.stringify({ migrated: true, was: '"old-shape"' }));
    sync.destroy();
  });

  it('cancel() aborts an in-flight item and marks it cancelled', async () => {
    const { queue, sync } = setup(`sync-test-cancel-${Math.random()}`);
    let fetchCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            fetchCalled = true;
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );

    const item = await queue.add(makeItem());
    const drainPromise = sync.drain();
    // Wait for the request to actually be in flight (rather than guessing a fixed delay) before
    // cancelling it — cancelling too early would abort before there's anything to abort.
    await waitForCondition(() => fetchCalled, { message: 'expected fetch() to have been called' });
    sync.cancel(item.id);
    await drainPromise;

    const updated = await queue.get(item.id);
    expect(updated?.status).toBe('cancelled');
    sync.destroy();
  });

  it('a cancel() landing while resolveHeaders() is in flight still ends in cancelled, even if resolveHeaders() then rejects', async () => {
    // resolveHeaders() isn't wired to the item's AbortController the way fetch() is, so a cancel()
    // arriving mid-resolveHeaders() has to be caught explicitly — otherwise a resolveHeaders()
    // rejection landing afterward would fall through to the shared retry logic and overwrite the
    // 'cancelled' status that queue.cancel() just wrote with a fresh 'pending'/'failed' one.
    let resolveHeadersCalled = false;
    let rejectResolveHeaders!: (reason: unknown) => void;
    const { queue, sync } = setup(
      `sync-test-cancel-during-resolve-headers-${Math.random()}`,
      undefined,
      {
        resolveHeaders: () =>
          new Promise((_resolve, reject) => {
            resolveHeadersCalled = true;
            rejectResolveHeaders = reject;
          }),
      },
    );
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const item = await queue.add(makeItem());
    const drainPromise = sync.drain();
    await waitForCondition(() => resolveHeadersCalled, {
      message: 'expected resolveHeaders() to have been called',
    });
    sync.cancel(item.id);
    rejectResolveHeaders(new Error('token refresh failed'));
    await drainPromise;

    const updated = await queue.get(item.id);
    expect(updated?.status).toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled(); // cancelled before resolveHeaders() even settled
    sync.destroy();
  });

  it('sweeps stale "sending" items back to pending before draining, then completes and purges it', async () => {
    const { queue, sync } = setup(`sync-test-stale-${Math.random()}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const now = Date.now();
    await queue.add(
      makeItem({ status: 'sending', updatedAt: now - 120_000, nextAttemptAt: now - 1 }),
    );
    await sync.drain();

    expect(await queue.list()).toHaveLength(0);
    sync.destroy();
  });

  it('expires an overdue item instead of sending it, and emits item-expired', async () => {
    const { queue, sync, events } = setup(`sync-test-expired-${Math.random()}`);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const now = Date.now();
    await queue.add(
      makeItem({ id: 'stale-item', createdAt: now - 10_000, maxAgeMs: 1_000, nextAttemptAt: now }),
    );
    await sync.drain();

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await queue.get('stale-item'))?.status).toBe('expired');
    expect(events.some((e) => e.type === 'item-expired')).toBe(true);
    sync.destroy();
  });

  it('does nothing while offline', async () => {
    const { queue, connection, sync } = setup(`sync-test-offline-${Math.random()}`);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await queue.add(makeItem());
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    window.dispatchEvent(new Event('offline'));

    await sync.drain();
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    window.dispatchEvent(new Event('online'));
    sync.destroy();
    connection.destroy();
  });

  it('reports onError with scope "db-open" when its own storage rejects, without throwing', async () => {
    const storage = openTestAdapter(`sync-test-dbopen-${Math.random()}`);
    const queue = new RequestQueue(storage);
    const connection = new ConnectionMonitor();
    const errors: Array<{ scope: string }> = [];
    const sync = new SyncManager({
      queue,
      connection,
      storage: {
        ...storage,
        get: () => Promise.reject(new Error('cannot open lock storage')),
        put: () => Promise.reject(new Error('cannot open lock storage')),
      },
      onError: (_error, context) => errors.push(context),
    });

    await queue.add(makeItem());

    await expect(sync.drain()).resolves.toBeUndefined();
    expect(errors).toContainEqual({ scope: 'db-open' });

    sync.destroy();
    connection.destroy();
  });

  it('reports onError with scope "sync" for an unexpected error during drain, without throwing', async () => {
    const connection = new ConnectionMonitor();
    const errors: Array<{ scope: string }> = [];
    // A deliberately broken queue double — `as unknown as RequestQueue` bypasses the structural
    // check since only `sweepStale` needs to exist for this test to exercise drain()'s outer,
    // catch-all error path.
    const brokenQueue = {
      sweepStale: async () => {
        throw new Error('boom');
      },
    } as unknown as RequestQueue;
    const sync = new SyncManager({
      queue: brokenQueue,
      connection,
      storage: openTestAdapter(`sync-test-syncerror-${Math.random()}`),
      onError: (_error, context) => errors.push(context),
    });

    await expect(sync.drain()).resolves.toBeUndefined();
    expect(errors).toContainEqual({ scope: 'sync' });

    sync.destroy();
    connection.destroy();
  });
});
