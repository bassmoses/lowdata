/**
 * Pluggable persistence layer. `RequestQueue`/`SyncManager`/the sync lock all talk to a
 * `StorageAdapter` rather than IndexedDB directly, so a host that isn't a browser tab — an
 * Electron main process, a React Native app, a unit test — can supply its own (SQLite,
 * AsyncStorage, in-memory) instead of being hard-wired to `indexedDB`.
 *
 * `createIndexedDbStorageAdapter()` is the default and the only one lowdata ships a full
 * implementation of; it reproduces the previous hard-coded behavior (open once, memoize the
 * connection, fall back to an in-memory store the first time IndexedDB proves unavailable) behind
 * this interface instead of ahead of it.
 */
import {
  createDbFallbackAccessor,
  idbClear,
  idbCount,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  openDatabase,
  type IdbStoreSpec,
} from './idb.js';
import type { LowdataErrorHandler } from './types.js';

export interface StorageAdapter {
  put<T>(store: string, value: T): Promise<void>;
  get<T>(store: string, key: string): Promise<T | undefined>;
  getAll<T>(store: string, options?: { indexName?: string; query?: unknown }): Promise<T[]>;
  delete(store: string, key: string): Promise<void>;
  clear(store: string): Promise<void>;
  count(store: string): Promise<number>;
  /** Whether the last write actually reached durable storage, or silently fell back to memory. */
  isPersistent(): boolean;
  /** Release any held connection/handle. Optional — adapters with nothing to release can omit it. */
  destroy?(): void | Promise<void>;
}

/**
 * Non-persistent adapter: same interface, plain `Map`s underneath. Used automatically as the
 * fallback inside `createIndexedDbStorageAdapter`, and available directly for tests, SSR, or any
 * environment that deliberately wants no persistence.
 */
export function createMemoryStorageAdapter(): StorageAdapter {
  const stores = new Map<string, Map<string, unknown>>();

  function storeFor(name: string): Map<string, unknown> {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    return store;
  }

  /** Reads the object's own `key`/`id`-like field so `get(store, key)` round-trips by identity. */
  function keyOf<T>(value: T): string {
    const record = value as Record<string, unknown>;
    const candidate = record.id ?? record.key ?? record.submissionId;
    return String(candidate);
  }

  return {
    async put<T>(store: string, value: T): Promise<void> {
      storeFor(store).set(keyOf(value), value);
    },
    async get<T>(store: string, key: string): Promise<T | undefined> {
      return storeFor(store).get(key) as T | undefined;
    },
    async getAll<T>(
      store: string,
      options?: { indexName?: string; query?: unknown },
    ): Promise<T[]> {
      const all = Array.from(storeFor(store).values()) as T[];
      if (!options?.indexName) return all;
      return all.filter(
        (item) => (item as Record<string, unknown>)[options.indexName!] === options.query,
      );
    },
    async delete(store: string, key: string): Promise<void> {
      storeFor(store).delete(key);
    },
    async clear(store: string): Promise<void> {
      storeFor(store).clear();
    },
    async count(store: string): Promise<number> {
      return storeFor(store).size;
    },
    isPersistent: () => false,
  };
}

export interface IndexedDbStorageAdapterOptions {
  /** Physical IndexedDB database name. Defaults to lowdata's shared production name. */
  dbName?: string;
  dbVersion?: number;
  stores?: IdbStoreSpec[];
  onError?: LowdataErrorHandler;
  /**
   * Below this many free bytes (per `navigator.storage.estimate()`, where available), `put()`
   * proactively reports `onError(..., { scope: 'quota' })` before attempting the write, instead of
   * only finding out reactively via a `QuotaExceededError`. Default 5 MB. Set to `0` to disable.
   */
  quotaWarningThresholdBytes?: number;
}

const DEFAULT_QUOTA_WARNING_BYTES = 5 * 1024 * 1024; // 5 MB
/** Re-checking storage quota is itself an async call; don't do it on every single put(). */
const QUOTA_CHECK_INTERVAL_MS = 10_000;

function hasStorageEstimate(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.estimate === 'function'
  );
}

/**
 * Physical IndexedDB connections are pooled and reference-counted per `dbName`, not per adapter
 * instance. Multiple `createIndexedDbStorageAdapter({ dbName: 'lowdata' })` calls — one default
 * `LowdataClient` created per page, a form's draft storage, several short-lived clients over an
 * app's lifetime — share one open connection instead of piling up a new one each time; the
 * connection only actually closes once every adapter that acquired it has released it.
 */
interface PooledConnection {
  promise: Promise<IDBDatabase>;
  refCount: number;
}
const connectionPool = new Map<string, PooledConnection>();

function acquirePooledConnection(
  dbName: string,
  dbVersion: number,
  stores: IdbStoreSpec[],
): { getDb: () => Promise<IDBDatabase>; release: () => Promise<void> } {
  function ensureEntry(): PooledConnection {
    let current = connectionPool.get(dbName);
    if (!current) {
      const created: PooledConnection = {
        promise: openDatabase(dbName, dbVersion, stores).catch((err) => {
          if (connectionPool.get(dbName) === created) connectionPool.delete(dbName);
          throw err;
        }),
        refCount: 0,
      };
      connectionPool.set(dbName, created);
      current = created;
    }
    return current;
  }

  // Captured once at acquire time — `release()` only ever decrements/closes *this* entry, even
  // if the pool's entry for `dbName` is later evicted and re-created out from under it (a failed
  // open, or `_resetIndexedDbPoolForTests` in a test). That keeps this adapter's own +1 from ever
  // being applied to (or closing) a connection some other, still-live adapter is now depending on.
  const myEntry = ensureEntry();
  myEntry.refCount += 1;

  let released = false;
  return {
    // Re-resolved on every call (not just returning `myEntry.promise`) so that if `myEntry` was
    // evicted and replaced, this adapter transparently starts using the fresh connection instead
    // of a stale, already-closed one — self-healing rather than a silent, permanent fallback to
    // in-memory storage after any external reset.
    getDb: () => ensureEntry().promise,
    release: async () => {
      if (released) return;
      released = true;
      if (connectionPool.get(dbName) !== myEntry) return; // already evicted/replaced — nothing of ours to release
      myEntry.refCount -= 1;
      if (myEntry.refCount <= 0) {
        connectionPool.delete(dbName);
        try {
          const db = await myEntry.promise;
          db.close();
        } catch {
          // Never successfully opened — nothing to close.
        }
      }
    },
  };
}

/** Test-only escape hatch: force-closes and evicts a pooled connection regardless of refCount. */
export async function _resetIndexedDbPoolForTests(dbName: string): Promise<void> {
  const entry = connectionPool.get(dbName);
  connectionPool.delete(dbName);
  if (!entry) return;
  try {
    const db = await entry.promise;
    db.close();
  } catch {
    // Never successfully opened — nothing to close.
  }
}

/** Default, IndexedDB-backed adapter — the same persistence behavior lowdata always had, now behind `StorageAdapter`. */
export function createIndexedDbStorageAdapter(
  options: IndexedDbStorageAdapterOptions = {},
): StorageAdapter {
  const dbName = options.dbName ?? 'lowdata';
  const dbVersion = options.dbVersion ?? 1;
  const stores = options.stores ?? [];
  const quotaThreshold = options.quotaWarningThresholdBytes ?? DEFAULT_QUOTA_WARNING_BYTES;
  const memory = createMemoryStorageAdapter();

  const pooled = acquirePooledConnection(dbName, dbVersion, stores);
  const accessor = createDbFallbackAccessor(pooled.getDb, options.onError);

  let lastQuotaCheckAt = 0;
  async function warnIfQuotaLow(): Promise<void> {
    if (quotaThreshold <= 0 || !options.onError || !hasStorageEstimate()) return;
    const now = Date.now();
    if (now - lastQuotaCheckAt < QUOTA_CHECK_INTERVAL_MS) return;
    lastQuotaCheckAt = now;
    try {
      const { quota, usage } = await navigator.storage.estimate();
      if (typeof quota !== 'number' || typeof usage !== 'number') return;
      const remaining = quota - usage;
      if (remaining < quotaThreshold) {
        options.onError(
          new Error(
            `lowdata: storage quota nearly exhausted (${remaining} bytes free, threshold ${quotaThreshold})`,
          ),
          { scope: 'quota' },
        );
      }
    } catch {
      // navigator.storage.estimate() itself failing tells us nothing actionable — ignore.
    }
  }

  return {
    async put<T>(store: string, value: T): Promise<void> {
      void warnIfQuotaLow(); // fire-and-forget: never delay/block the actual write on this check
      await accessor.run(
        (db) => idbPut(db, store, value),
        () => memory.put(store, value),
      );
    },
    async get<T>(store: string, key: string): Promise<T | undefined> {
      return accessor.run(
        (db) => idbGet<T>(db, store, key),
        () => memory.get<T>(store, key),
      );
    },
    async getAll<T>(
      store: string,
      queryOptions?: { indexName?: string; query?: unknown },
    ): Promise<T[]> {
      return accessor.run(
        (db) =>
          idbGetAll<T>(db, store, {
            indexName: queryOptions?.indexName,
            query: queryOptions?.query as IDBValidKey | IDBKeyRange | undefined,
          }),
        () => memory.getAll<T>(store, queryOptions),
      );
    },
    async delete(store: string, key: string): Promise<void> {
      await accessor.run(
        (db) => idbDelete(db, store, key),
        () => memory.delete(store, key),
      );
    },
    async clear(store: string): Promise<void> {
      await accessor.run(
        (db) => idbClear(db, store),
        () => memory.clear(store),
      );
    },
    async count(store: string): Promise<number> {
      return accessor.run(
        (db) => idbCount(db, store),
        () => memory.count(store),
      );
    },
    isPersistent: () => accessor.isPersistent(),
    destroy: () => pooled.release(),
  };
}
