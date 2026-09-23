import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIndexedDbStorageAdapter,
  type StorageAdapter,
} from '../../src/core/storageAdapter.js';
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

  it('only one of two concurrent (unawaited) acquires from different owners wins — Promise-level race, not just cross-tab', async () => {
    // acquireStorageLock is a non-atomic get-then-put; firing two acquires without awaiting
    // between them (e.g. two components mounting at once in the same tab) used to let both see
    // the lock as free and both succeed. Regression test for that bug.
    const storage = makeStorage(`lock-race-${Math.random()}`);

    const [a, b] = await Promise.all([
      acquireSyncLock(storage, 'sync', 'owner-a'),
      acquireSyncLock(storage, 'sync', 'owner-b'),
    ]);

    expect([!!a, !!b].filter(Boolean)).toHaveLength(1);
    await a?.release();
    await b?.release();
  });

  it('serializes many concurrent acquires for the same name so exactly one wins at a time', async () => {
    const storage = makeStorage(`lock-race-many-${Math.random()}`);

    const handles = await Promise.all(
      Array.from({ length: 8 }, (_, i) => acquireSyncLock(storage, 'sync', `owner-${i}`)),
    );

    expect(handles.filter(Boolean)).toHaveLength(1);
    await handles.find(Boolean)?.release();
  });

  it('a stale lock (holder never released it, e.g. crashed/closed tab) is reclaimed by a new acquirer once expired', async () => {
    const storage = makeStorage(`lock-stale-${Math.random()}`);

    await storage.put('meta', {
      key: 'syncLock:sync',
      ownerId: 'dead-owner',
      expiresAt: Date.now() - 1, // already expired
    });

    const result = await acquireSyncLock(storage, 'sync', 'owner-new');

    expect(result).toBeDefined();
    await result?.release();
  });

  it('a non-expired lock held by another owner is NOT reclaimed', async () => {
    const storage = makeStorage(`lock-not-stale-${Math.random()}`);

    await storage.put('meta', {
      key: 'syncLock:sync',
      ownerId: 'live-owner',
      expiresAt: Date.now() + 60_000,
    });

    const result = await acquireSyncLock(storage, 'sync', 'owner-new');

    expect(result).toBeUndefined();
  });

  it('renew() extends the lease so the lock is not reclaimed as stale mid-critical-section', async () => {
    const storage = makeStorage(`lock-renew-${Math.random()}`);
    const key = 'syncLock:sync';

    const handle = await acquireSyncLock(storage, 'sync', 'owner-1');
    expect(handle).toBeDefined();

    // Simulate time passing close to the original expiry, then renew.
    await storage.put('meta', {
      key,
      ownerId: 'owner-1',
      expiresAt: Date.now() + 1,
    });
    await handle?.renew();

    const record = await storage.get<{ expiresAt: number }>('meta', key);
    expect(record?.expiresAt).toBeGreaterThan(Date.now() + 1000);

    await handle?.release();
  });

  it('release() only removes the record if this owner still holds it (no-op otherwise, and safe to call twice)', async () => {
    const storage = makeStorage(`lock-release-noop-${Math.random()}`);

    const handle = await acquireSyncLock(storage, 'sync', 'owner-1');
    expect(handle).toBeDefined();

    await handle?.release();
    // Second release: record is already gone, ownerId check has nothing to match — must not throw.
    await expect(handle?.release()).resolves.toBeUndefined();

    // Lock is free again for another owner.
    const next = await acquireSyncLock(storage, 'sync', 'owner-2');
    expect(next).toBeDefined();
    await next?.release();
  });

  it('release-then-reacquire by a different owner succeeds immediately', async () => {
    const storage = makeStorage(`lock-release-reacquire-${Math.random()}`);

    const first = await acquireSyncLock(storage, 'sync', 'owner-1');
    await first?.release();

    const second = await acquireSyncLock(storage, 'sync', 'owner-2');
    expect(second).toBeDefined();
    await second?.release();
  });
});

describe('acquireSyncLock (Web Locks API path)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Minimal fake matching the subset of the real `navigator.locks` shape this module depends on.
   * Mirrors the real Web Locks contract: `request()`'s returned promise doesn't settle until the
   * callback's own returned promise does — `acquireWebLock` relies on that to keep the lock "held"
   * until `release()` is called.
   */
  function makeFakeLockManager(behavior: 'grant' | 'busy' | 'throw') {
    return {
      request: vi.fn(
        (_name: string, _options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => {
          if (behavior === 'throw') {
            return Promise.reject(new Error('locks.request failed'));
          }
          if (behavior === 'busy') {
            return Promise.resolve(callback(null));
          }
          return Promise.resolve(callback({ name: _name }));
        },
      ),
    };
  }

  it('grants the lock via navigator.locks when available, and release() lets a subsequent acquire proceed', async () => {
    const locks = makeFakeLockManager('grant');
    vi.stubGlobal('navigator', { ...navigator, locks });

    const handle = await acquireSyncLock(undefined, 'sync', 'owner-1');

    expect(handle).toBeDefined();
    expect(locks.request).toHaveBeenCalledWith(
      'sync',
      { ifAvailable: true },
      expect.any(Function),
    );
    await expect(handle?.release()).resolves.toBeUndefined();
  });

  it('returns undefined when navigator.locks reports the lock is already held elsewhere (ifAvailable: true, callback(null))', async () => {
    const locks = makeFakeLockManager('busy');
    vi.stubGlobal('navigator', { ...navigator, locks });

    const handle = await acquireSyncLock(undefined, 'sync', 'owner-1');

    expect(handle).toBeUndefined();
  });

  it('returns undefined (does not throw) when navigator.locks.request itself rejects', async () => {
    const locks = makeFakeLockManager('throw');
    vi.stubGlobal('navigator', { ...navigator, locks });

    const handle = await acquireSyncLock(undefined, 'sync', 'owner-1');

    expect(handle).toBeUndefined();
  });

  it("renew() is a documented no-op for the Web Locks path — the lock is held for the callback's lifetime regardless", async () => {
    const locks = makeFakeLockManager('grant');
    vi.stubGlobal('navigator', { ...navigator, locks });

    const handle = await acquireSyncLock(undefined, 'sync', 'owner-1');

    await expect(handle?.renew()).resolves.toBeUndefined();
    await handle?.release();
  });
});
