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
    expect(
      blockedEvent?.type === 'items-blocked' && blockedEvent.items.map((i) => i.id),
    ).toEqual(['child']);
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
    expect(
      blockedEvent?.type === 'items-blocked' && blockedEvent.items.map((i) => i.id),
    ).toContain('newly-added');
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
      { syncConcurrency: 5, circuitBreaker: { threshold: 1, cooldownMs: 10 } },
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
    await new Promise((r) => setTimeout(r, 15)); // past cooldownMs: 10
    await sync.drain();

    // Exactly one more fetch (the trial) — not up to 4 more.
    expect(fetchCalls).toBe(2);
    sync.destroy();
  });

  it('migrates a queue item whose schemaVersion is stale before sending it', async () => {
    const { queue, sync } = setup(
      `sync-test-migrate-${Math.random()}`,
      undefined,
      {
        schemaVersion: 2,
        migrateQueueItem: (item) => ({
          ...item,
          body: JSON.stringify({ migrated: true, was: item.body }),
        }),
      },
    );
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
