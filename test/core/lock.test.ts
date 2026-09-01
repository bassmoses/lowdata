import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/core/idb.js';
import { acquireSyncLock } from '../../src/core/lock.js';

async function makeDb(name: string): Promise<IDBDatabase> {
  return openDatabase(name, 1, [{ name: 'meta', keyPath: 'key' }]);
}

describe('acquireSyncLock (IndexedDB fallback — jsdom has no Web Locks API)', () => {
  it('grants the lock when free, and blocks a second owner until released', async () => {
    const db = await makeDb(`lock-test-${Math.random()}`);

    const first = await acquireSyncLock(db, 'sync', 'owner-1');
    expect(first).toBeDefined();

    const second = await acquireSyncLock(db, 'sync', 'owner-2');
    expect(second).toBeUndefined();

    await first?.release();

    const third = await acquireSyncLock(db, 'sync', 'owner-2');
    expect(third).toBeDefined();
    await third?.release();
  });

  it('lets the same owner re-acquire its own lock (idempotent renewal)', async () => {
    const db = await makeDb(`lock-test-reacquire-${Math.random()}`);

    const first = await acquireSyncLock(db, 'sync', 'owner-1');
    expect(first).toBeDefined();

    const again = await acquireSyncLock(db, 'sync', 'owner-1');
    expect(again).toBeDefined();

    await again?.release();
  });

  it('returns undefined when no database is available and no Web Locks API exists', async () => {
    const result = await acquireSyncLock(undefined, 'sync', 'owner-1');
    expect(result).toBeUndefined();
  });
});
