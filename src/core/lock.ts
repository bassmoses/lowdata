import type { StorageAdapter } from './storageAdapter.js';

/** How long a fallback lock record is honored before it's considered stale/abandoned. */
export const LOCK_STALE_AFTER_MS = 15_000;

export interface SyncLockHandle {
  release: () => Promise<void>;
  /** Extend a fallback lock's stale-after window during a long-running critical section. No-op for Web Locks. */
  renew: () => Promise<void>;
}

interface WebLockLike {
  name: string;
}
interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: WebLockLike | null) => Promise<void> | void,
  ): Promise<unknown>;
}

function getLockManager(): LockManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { locks?: LockManagerLike }).locks;
}

/**
 * Acquire a named exclusive lock via the Web Locks API, non-blocking (`ifAvailable: true`):
 * resolves to `undefined` immediately if another tab already holds it rather than queueing.
 */
function acquireWebLock(locks: LockManagerLike, name: string): Promise<SyncLockHandle | undefined> {
  return new Promise((resolveOuter) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolveOuter(undefined);
          return;
        }
        return new Promise<void>((resolveInner) => {
          resolveOuter({
            release: async () => resolveInner(),
            renew: async () => {
              /* held exclusively for the lifetime of the callback; nothing to renew */
            },
          });
        });
      })
      .catch(() => resolveOuter(undefined));
  });
}

interface SyncLockRecord {
  key: string;
  ownerId: string;
  expiresAt: number;
}

/**
 * `acquireStorageLock` is a non-atomic read-then-write against `storage` (`get`, decide, `put`) —
 * a `StorageAdapter` has no compare-and-swap. Two `acquireSyncLock` calls fired without awaiting
 * between them (e.g. two components in the same page both racing to acquire on mount) can each
 * complete their `get` — both seeing the lock free — before either `put` lands, so both would
 * otherwise return a granted handle: the exact mutual-exclusion bug this lock exists to prevent.
 * This queue serializes `acquireStorageLock` calls per (storage instance, lock name) within one JS
 * realm so only one read-modify-write runs at a time, closing that race for same-tab callers. It
 * cannot and does not attempt to close the equivalent race across *different* tabs/processes
 * sharing the same physical storage — that's the documented staleness/best-effort trade-off of the
 * fallback path (see `acquireSyncLock`'s doc comment); only the Web Locks API is race-free there.
 */
const pendingAcquiresByStorage = new WeakMap<StorageAdapter, Map<string, Promise<unknown>>>();

function serializeAcquire<T>(storage: StorageAdapter, name: string, fn: () => Promise<T>): Promise<T> {
  let byName = pendingAcquiresByStorage.get(storage);
  if (!byName) {
    byName = new Map();
    pendingAcquiresByStorage.set(storage, byName);
  }
  const prior = byName.get(name) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // Swallow rejections in the chain itself (they still propagate to this call's own caller via
  // `run`) so one failed acquire doesn't permanently wedge the queue for the next caller.
  byName.set(name, run.then(
    () => undefined,
    () => undefined,
  ));
  return run;
}

async function acquireStorageLock(
  storage: StorageAdapter,
  name: string,
  ownerId: string,
): Promise<SyncLockHandle | undefined> {
  return serializeAcquire(storage, name, async () => {
    const key = `syncLock:${name}`;
    const now = Date.now();
    const existing = await storage.get<SyncLockRecord>('meta', key);
    if (existing && existing.expiresAt > now && existing.ownerId !== ownerId) {
      return undefined;
    }
    await storage.put<SyncLockRecord>('meta', {
      key,
      ownerId,
      expiresAt: now + LOCK_STALE_AFTER_MS,
    });
    return {
      release: async () => {
        const current = await storage.get<SyncLockRecord>('meta', key);
        if (current?.ownerId === ownerId) {
          await storage.delete('meta', key);
        }
      },
      renew: async () => {
        await storage.put<SyncLockRecord>('meta', {
          key,
          ownerId,
          expiresAt: Date.now() + LOCK_STALE_AFTER_MS,
        });
      },
    };
  });
}

/**
 * Acquire a cross-tab exclusive lock, preferring the Web Locks API where available (correct by
 * construction, no staleness window) and falling back to a `StorageAdapter` record (stale after
 * `LOCK_STALE_AFTER_MS`) elsewhere — including for non-browser adapters (Electron main, React
 * Native) where there's no Web Locks API at all. Returns `undefined` if the lock could not be
 * acquired.
 */
export async function acquireSyncLock(
  storage: StorageAdapter | undefined,
  name: string,
  ownerId: string,
): Promise<SyncLockHandle | undefined> {
  const locks = getLockManager();
  if (locks) {
    return acquireWebLock(locks, name);
  }
  if (!storage) return undefined;
  return acquireStorageLock(storage, name, ownerId);
}
