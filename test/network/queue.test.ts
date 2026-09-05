import { describe, expect, it } from 'vitest';
import { RequestQueue } from '../../src/network/queue.js';
import { createMemoryStorageAdapter } from '../../src/core/storageAdapter.js';
import { openTestAdapter } from '../helpers/db.js';
import { makeQueueItem } from '../helpers/queueItem.js';

function makeQueue(dbName: string): RequestQueue {
  return new RequestQueue(openTestAdapter(dbName));
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

  it('selectEligible withholds an item until its dependsOn ids are resolved', async () => {
    const queue = makeQueue(`queue-test-deps-${Math.random()}`);
    const now = Date.now();
    await queue.add(makeQueueItem({ id: 'parent', status: 'pending', nextAttemptAt: now }));
    await queue.add(
      makeQueueItem({ id: 'child', dependsOn: ['parent'], nextAttemptAt: now }),
    );

    // Parent still present and pending — child is blocked.
    expect((await queue.selectEligible(now)).map((i) => i.id)).toEqual(['parent']);

    // Parent succeeded and was purged (the real lifecycle — SyncManager removes 'done' items).
    await queue.remove('parent');
    expect((await queue.selectEligible(now)).map((i) => i.id)).toEqual(['child']);
  });

  it('selectEligible unblocks a dependency that was explicitly cancelled', async () => {
    const queue = makeQueue(`queue-test-deps-cancelled-${Math.random()}`);
    const now = Date.now();
    await queue.add(makeQueueItem({ id: 'parent', status: 'cancelled', nextAttemptAt: now }));
    await queue.add(makeQueueItem({ id: 'child', dependsOn: ['parent'], nextAttemptAt: now }));

    expect((await queue.selectEligible(now)).map((i) => i.id)).toEqual(['child']);
  });

  it('selectEligible keeps blocking on a dependency stuck in "failed"', async () => {
    const queue = makeQueue(`queue-test-deps-failed-${Math.random()}`);
    const now = Date.now();
    await queue.add(makeQueueItem({ id: 'parent', status: 'failed', nextAttemptAt: now }));
    await queue.add(makeQueueItem({ id: 'child', dependsOn: ['parent'], nextAttemptAt: now }));

    expect(await queue.selectEligible(now)).toHaveLength(0);
  });

  it('expireOverdue marks a pending item past its maxAgeMs as expired, leaving fresh ones alone', async () => {
    const queue = makeQueue(`queue-test-expire-${Math.random()}`);
    const now = Date.now();
    await queue.add(
      makeQueueItem({ id: 'old', createdAt: now - 10_000, maxAgeMs: 5_000, nextAttemptAt: now }),
    );
    await queue.add(
      makeQueueItem({ id: 'new', createdAt: now, maxAgeMs: 5_000, nextAttemptAt: now }),
    );

    const expired = await queue.expireOverdue(now);
    expect(expired.map((i) => i.id)).toEqual(['old']);
    expect((await queue.get('old'))?.status).toBe('expired');
    expect((await queue.get('new'))?.status).toBe('pending');
    expect(await queue.selectEligible(now)).toHaveLength(1); // only 'new' left eligible
  });

  it('round-trips an encrypted body transparently — callers never see ciphertext', async () => {
    const calls: string[] = [];
    const queue = new RequestQueue(openTestAdapter(`queue-test-encrypt-${Math.random()}`), {
      encrypt: async (plaintext) => {
        calls.push('encrypt');
        return Buffer.from(plaintext).toString('base64');
      },
      decrypt: async (ciphertext) => {
        calls.push('decrypt');
        return Buffer.from(ciphertext, 'base64').toString('utf-8');
      },
    });

    const item = makeQueueItem({ body: '{"secret":true}' });
    await queue.add(item);

    const fetched = await queue.get(item.id);
    expect(fetched?.body).toBe('{"secret":true}');
    expect(fetched?.bodyEncrypted).toBeUndefined();
    expect(calls).toContain('encrypt');
    expect(calls).toContain('decrypt');

    const listed = (await queue.list())[0];
    expect(listed?.body).toBe('{"secret":true}');
  });

  it('isolates one item\'s decrypt failure instead of it blocking the whole queue', async () => {
    const errors: Array<{ scope: string }> = [];
    const queue = new RequestQueue(
      openTestAdapter(`queue-test-decrypt-fail-${Math.random()}`),
      {
        encrypt: async (plaintext) => plaintext, // pass-through, doesn't matter for this test
        decrypt: async () => {
          throw new Error('wrong key');
        },
      },
      (_error, context) => errors.push(context),
    );

    const poisoned = await queue.add(makeQueueItem({ id: 'poisoned', body: '{"a":1}' }));
    const healthy = await queue.add(makeQueueItem({ id: 'healthy', body: null })); // no body — never encrypted, decrypts trivially

    // list() must not reject just because one item's decrypt throws — that would make every other
    // pending item unreachable too, since selectEligible()/drain() build on top of list().
    const all = await queue.list();
    expect(all).toHaveLength(2);
    expect(errors).toContainEqual({ scope: 'decrypt' });

    const poisonedAfter = all.find((i) => i.id === poisoned.id);
    expect(poisonedAfter?.status).toBe('failed');
    const healthyAfter = all.find((i) => i.id === healthy.id);
    expect(healthyAfter?.status).toBe('pending');

    // The poisoned item is excluded from eligibility going forward (it's 'failed', not 'pending')
    // — the rest of the queue keeps flowing.
    const eligible = await queue.selectEligible(Date.now());
    expect(eligible.map((i) => i.id)).toEqual(['healthy']);
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
    const queue = new RequestQueue(createMemoryStorageAdapter());
    const item = makeQueueItem();

    await queue.add(item);
    expect(queue.isPersistent()).toBe(false);
    expect(await queue.get(item.id)).toEqual(item);
    expect(await queue.list()).toHaveLength(1);
  });
});
