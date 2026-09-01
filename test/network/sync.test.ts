import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionMonitor } from '../../src/core/connection.js';
import { RequestQueue } from '../../src/network/queue.js';
import { SyncManager } from '../../src/network/sync.js';
import type { SyncEvent } from '../../src/network/types.js';
import { openTestDb } from '../helpers/db.js';
import { makeQueueItem as makeItem } from '../helpers/queueItem.js';

function setup(
  dbName: string,
  retryConfig = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitter: 'none' as const },
) {
  const getDb = openTestDb(dbName);
  const queue = new RequestQueue(getDb);
  const connection = new ConnectionMonitor();
  const events: SyncEvent[] = [];
  const sync = new SyncManager({
    queue,
    connection,
    getDb,
    syncConcurrency: 1,
    retryConfig,
    onEvent: (e) => events.push(e),
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
    // The server asked for a 3600s Retry-After, but retryConfig.maxDelayMs caps it at 5s —
    // matching how the live-retry path (retry.ts) caps the same header.
    expect(updated!.nextAttemptAt - before).toBeLessThanOrEqual(5_050);
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

  it('cancel() aborts an in-flight item and marks it cancelled', async () => {
    const { queue, sync } = setup(`sync-test-cancel-${Math.random()}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );

    const item = await queue.add(makeItem());
    const drainPromise = sync.drain();
    await new Promise((resolve) => setTimeout(resolve, 10));
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
});
