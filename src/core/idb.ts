/**
 * Minimal promise-based IndexedDB wrapper. Deliberately small and hand-rolled (no `idb`
 * dependency) — lowdata only needs put/get/getAll/delete/clear against a handful of stores.
 */
import type { LowdataErrorHandler } from './types.js';

export interface IdbIndexSpec {
  name: string;
  keyPath: string;
  unique?: boolean;
}

export interface IdbStoreSpec {
  name: string;
  keyPath: string;
  indexes?: IdbIndexSpec[];
}

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function openDatabase(
  name: string,
  version: number,
  stores: IdbStoreSpec[],
): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('lowdata: IndexedDB is not available in this environment'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of stores) {
        if (db.objectStoreNames.contains(store.name)) continue;
        const objectStore = db.createObjectStore(store.name, { keyPath: store.keyPath });
        for (const index of store.indexes ?? []) {
          objectStore.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('lowdata: failed to open IndexedDB database'));
    request.onblocked = () =>
      reject(new Error('lowdata: IndexedDB open blocked by another connection'));
  });
}

function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('lowdata: IndexedDB request failed'));
  });
}

function wrapTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('lowdata: IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('lowdata: IndexedDB transaction aborted'));
  });
}

export async function idbPut<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  await wrapTransaction(tx);
}

export async function idbGet<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const tx = db.transaction(storeName, 'readonly');
  return wrapRequest<T>(tx.objectStore(storeName).get(key) as IDBRequest<T>);
}

export async function idbDelete(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<void> {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await wrapTransaction(tx);
}

export async function idbGetAll<T>(
  db: IDBDatabase,
  storeName: string,
  options?: { indexName?: string; query?: IDBValidKey | IDBKeyRange },
): Promise<T[]> {
  const tx = db.transaction(storeName, 'readonly');
  const source = options?.indexName
    ? tx.objectStore(storeName).index(options.indexName)
    : tx.objectStore(storeName);
  return wrapRequest<T[]>(source.getAll(options?.query) as IDBRequest<T[]>);
}

export async function idbClear(db: IDBDatabase, storeName: string): Promise<void> {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).clear();
  await wrapTransaction(tx);
}

export async function idbCount(db: IDBDatabase, storeName: string): Promise<number> {
  const tx = db.transaction(storeName, 'readonly');
  return wrapRequest<number>(tx.objectStore(storeName).count());
}

/** lowdata's shared database schema, opened once per store namespace (see `getSharedDb`). */
export const LOWDATA_DB_NAME = 'lowdata';
export const LOWDATA_DB_VERSION = 1;

export const LOWDATA_STORES: IdbStoreSpec[] = [
  {
    name: 'queue',
    keyPath: 'id',
    indexes: [
      { name: 'status', keyPath: 'status' },
      { name: 'priority', keyPath: 'priority' },
      { name: 'nextAttemptAt', keyPath: 'nextAttemptAt' },
    ],
  },
  { name: 'meta', keyPath: 'key' },
  {
    name: 'formDrafts',
    keyPath: 'submissionId',
    indexes: [{ name: 'formId', keyPath: 'formId' }],
  },
];

let sharedDbPromise: Promise<IDBDatabase> | undefined;

/** Lazily opens (and memoizes) the single shared lowdata database connection. */
export function getSharedDb(): Promise<IDBDatabase> {
  if (!sharedDbPromise) {
    sharedDbPromise = openDatabase(LOWDATA_DB_NAME, LOWDATA_DB_VERSION, LOWDATA_STORES).catch(
      (err) => {
        sharedDbPromise = undefined;
        throw err;
      },
    );
  }
  return sharedDbPromise;
}

/**
 * Test-only escape hatch to force a fresh connection between test cases. Closes the underlying
 * `IDBDatabase` connection (not just the cached promise) so a subsequent `indexedDB.deleteDatabase`
 * in test teardown completes instead of hanging in a "blocked" state waiting for this connection
 * to close.
 */
export async function _resetSharedDbForTests(): Promise<void> {
  const previous = sharedDbPromise;
  sharedDbPromise = undefined;
  if (!previous) return;
  try {
    const db = await previous;
    db.close();
  } catch {
    // Previous open attempt failed — nothing to close.
  }
}

/** Runs an operation against IndexedDB, or an in-memory fallback once IndexedDB has proven unavailable. */
export interface DbFallbackAccessor {
  run<T>(fn: (db: IDBDatabase) => Promise<T>, fallback: () => T | Promise<T>): Promise<T>;
  isPersistent(): boolean;
}

/**
 * Shared "try IndexedDB, fall back to an in-memory implementation" policy, used by both the
 * request queue and form draft storage. The fallback exists so importing lowdata never throws in
 * an environment without IndexedDB (SSR, locked-down browsers) — not to promise durability there.
 *
 * A `getDb()` failure is structural (IndexedDB genuinely isn't available) and permanently flips to
 * the in-memory fallback for the rest of the session — an environment without IndexedDB isn't
 * expected to gain it mid-session. A failure from `fn(db)` on an already-open database (a
 * transient `QuotaExceededError`, a blocked transaction, another tab's version-change) is *not*
 * treated as "IndexedDB is unavailable" — only that one call falls back to memory; persistence
 * keeps being attempted on the next call. Conflating the two used to mean one quota hiccup could
 * silently and permanently disable persistence for an otherwise-healthy session.
 */
export function createDbFallbackAccessor(
  getDb: () => Promise<IDBDatabase>,
  onError?: LowdataErrorHandler,
): DbFallbackAccessor {
  let dbAvailable = true;
  return {
    async run<T>(fn: (db: IDBDatabase) => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
      if (!dbAvailable) return fallback();

      let db: IDBDatabase;
      try {
        db = await getDb();
      } catch (error) {
        dbAvailable = false;
        onError?.(error, { scope: 'db-open' });
        return fallback();
      }

      try {
        return await fn(db);
      } catch (error) {
        onError?.(error, { scope: 'db-operation' });
        return fallback();
      }
    },
    isPersistent: () => dbAvailable,
  };
}
