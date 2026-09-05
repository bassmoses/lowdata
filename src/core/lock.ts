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

async function acquireStorageLock(
  storage: StorageAdapter,
  name: string,
  ownerId: string,
): Promise<SyncLockHandle | undefined> {
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
