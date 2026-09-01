import { describe, expect, it } from 'vitest';
import { RequestQueue } from '../../src/network/queue.js';
import { openTestDb } from '../helpers/db.js';
import { makeQueueItem } from '../helpers/queueItem.js';

function makeQueue(dbName: string): RequestQueue {
  return new RequestQueue(openTestDb(dbName));
}

describe('RequestQueue', () => {
  it('adds, gets, lists, and removes items', async () => {
    const queue = makeQueue(`queue-test-${Math.random()}`);
    const item = makeQueueItem();
    await queue.add(item);

    expect(await queue.get(item.id)).toEqual(item);
    expect(await queue.list()).toHaveLength(1);

    await queue.remove(item.id);
    expect(await queue.get(item.id)).toBeUndefined();
    expect(queue.isPersistent()).toBe(true);
  });

  it('filters list() by status', async () => {
    const queue = makeQueue(`queue-test-status-${Math.random()}`);
    await queue.add(makeQueueItem({ id: 'a', status: 'pending' }));
    await queue.add(makeQueueItem({ id: 'b', status: 'done' }));

    expect(await queue.list({ status: 'pending' })).toHaveLength(1);
    expect(await queue.list({ status: 'done' })).toHaveLength(1);
  });

  it('selectEligible sorts by priority then creation time, and excludes not-yet-due items', async () => {
    const queue = makeQueue(`queue-test-eligible-${Math.random()}`);
    const now = Date.now();
    await queue.add(
      makeQueueItem({ id: 'low', priority: 'low', createdAt: now, nextAttemptAt: now }),
    );
    await queue.add(
      makeQueueItem({ id: 'high', priority: 'high', createdAt: now + 1, nextAttemptAt: now }),
    );
    await queue.add(
      makeQueueItem({
        id: 'future',
        priority: 'high',
        createdAt: now,
        nextAttemptAt: now + 100_000,
      }),
    );

    const eligible = await queue.selectEligible(now);
    expect(eligible.map((i) => i.id)).toEqual(['high', 'low']);
  });

  it('sweepStale revives items stuck in "sending" past the stale window, leaving fresh ones alone', async () => {
    const queue = makeQueue(`queue-test-stale-${Math.random()}`);
    const now = Date.now();
    await queue.add(makeQueueItem({ id: 'stuck', status: 'sending', updatedAt: now - 120_000 }));
    await queue.add(makeQueueItem({ id: 'fresh', status: 'sending', updatedAt: now }));

    const revived = await queue.sweepStale(60_000, now);
    expect(revived.map((i) => i.id)).toEqual(['stuck']);
    expect((await queue.get('stuck'))?.status).toBe('pending');
    expect((await queue.get('fresh'))?.status).toBe('sending');
  });

  it('clear() empties the queue', async () => {
    const queue = makeQueue(`queue-test-clear-${Math.random()}`);
    await queue.add(makeQueueItem());
    await queue.add(makeQueueItem());
    await queue.clear();
    expect(await queue.list()).toHaveLength(0);
  });

  it('falls back to an in-memory queue when IndexedDB is unavailable, without throwing', async () => {
    const queue = new RequestQueue(() => Promise.reject(new Error('no idb in this environment')));
    const item = makeQueueItem();

    await queue.add(item);
    expect(queue.isPersistent()).toBe(false);
    expect(await queue.get(item.id)).toEqual(item);
    expect(await queue.list()).toHaveLength(1);
  });
});
