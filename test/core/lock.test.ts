import { describe, expect, it } from 'vitest';
import { createIndexedDbStorageAdapter, type StorageAdapter } from '../../src/core/storageAdapter.js';
import { acquireSyncLock } from '../../src/core/lock.js';

function makeStorage(name: string): StorageAdapter {
  return createIndexedDbStorageAdapter({
    dbName: name,
    stores: [{ name: 'meta', keyPath: 'key' }],
  });
}

describe('acquireSyncLock (IndexedDB fallback — jsdom has no Web Locks API)', () => {
  it('grants the lock when free, and blocks a second owner until released', async () => {
    const storage = makeStorage(`lock-test-${Math.random()}`);

    const first = await acquireSyncLock(storage, 'sync', 'owner-1');
    expect(first).toBeDefined();

    const second = await acquireSyncLock(storage, 'sync', 'owner-2');
    expect(second).toBeUndefined();

    await first?.release();

    const third = await acquireSyncLock(storage, 'sync', 'owner-2');
    expect(third).toBeDefined();
    await third?.release();
  });

  it('lets the same owner re-acquire its own lock (idempotent renewal)', async () => {
    const storage = makeStorage(`lock-test-reacquire-${Math.random()}`);

    const first = await acquireSyncLock(storage, 'sync', 'owner-1');
    expect(first).toBeDefined();

    const again = await acquireSyncLock(storage, 'sync', 'owner-1');
    expect(again).toBeDefined();

    await again?.release();
  });

  it('returns undefined when no storage is available and no Web Locks API exists', async () => {
    const result = await acquireSyncLock(undefined, 'sync', 'owner-1');
    expect(result).toBeUndefined();
  });
});
