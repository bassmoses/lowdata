import type { StorageAdapter } from './storageAdapter.js';

/**
 * The subset of `@react-native-async-storage/async-storage`'s API this adapter actually needs —
 * described structurally rather than imported, so `lowdata` never takes a real dependency (peer or
 * otherwise) on React Native or that package. Its default export already satisfies this shape, so
 * `createAsyncStorageAdapter(AsyncStorage)` just works; any other key-value store with the same
 * four methods (a polyfill, a test double) works identically.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  /** Used opportunistically for `clear()` when available — falls back to sequential `removeItem` otherwise. */
  multiRemove?(keys: readonly string[]): Promise<void>;
}

const DEFAULT_NAMESPACE = 'lowdata';

/**
 * `StorageAdapter` over AsyncStorage (or anything AsyncStorage-shaped) — for React Native, where
 * there's no IndexedDB. AsyncStorage itself has no concept of separate "stores" or secondary
 * indexes, so this emulates both: each store's keys are prefixed (`` `${namespace}:${store}:` ``),
 * and `getAll()`'s optional index filter is just a linear scan+filter in JS after fetching every
 * key in that store — entirely reasonable for an offline queue's realistic size (tens to low
 * hundreds of items), not a general-purpose query engine.
 *
 * `namespace` doubles as the same per-tenant isolation `createIndexedDbStorageAdapter`'s `dbName`
 * gives on the web — e.g. one namespace per event/organizer on a shared device, so switching
 * context can't leak or cross-send another context's queued writes.
 */
export function createAsyncStorageAdapter(
  storage: AsyncStorageLike,
  namespace: string = DEFAULT_NAMESPACE,
): StorageAdapter {
  function keyFor(store: string, id: string): string {
    return `${namespace}:${store}:${id}`;
  }
  function prefixFor(store: string): string {
    return `${namespace}:${store}:`;
  }
  /** Reads the object's own `id`/`key`/`submissionId`-like field, matching every store's record shape. */
  function idOf(value: unknown): string {
    const record = value as Record<string, unknown>;
    return String(record.id ?? record.key ?? record.submissionId);
  }
  async function keysInStore(store: string): Promise<string[]> {
    const prefix = prefixFor(store);
    const allKeys = await storage.getAllKeys();
    return allKeys.filter((key) => key.startsWith(prefix));
  }

  return {
    async put<T>(store: string, value: T): Promise<void> {
      await storage.setItem(keyFor(store, idOf(value)), JSON.stringify(value));
    },
    async get<T>(store: string, key: string): Promise<T | undefined> {
      const raw = await storage.getItem(keyFor(store, key));
      return raw != null ? (JSON.parse(raw) as T) : undefined;
    },
    async getAll<T>(
      store: string,
      options?: { indexName?: string; query?: unknown },
    ): Promise<T[]> {
      const keys = await keysInStore(store);
      const raws = await Promise.all(keys.map((key) => storage.getItem(key)));
      const records = raws
        .filter((raw): raw is string => raw != null)
        .map((raw) => JSON.parse(raw) as T);
      if (!options?.indexName) return records;
      const indexName = options.indexName;
      return records.filter(
        (record) => (record as Record<string, unknown>)[indexName] === options.query,
      );
    },
    async delete(store: string, key: string): Promise<void> {
      await storage.removeItem(keyFor(store, key));
    },
    async clear(store: string): Promise<void> {
      const keys = await keysInStore(store);
      if (keys.length === 0) return;
      if (storage.multiRemove) {
        await storage.multiRemove(keys);
      } else {
        await Promise.all(keys.map((key) => storage.removeItem(key)));
      }
    },
    async count(store: string): Promise<number> {
      return (await keysInStore(store)).length;
    },
    // AsyncStorage always persists (backed by SQLite/files on-device) — there's no equivalent of
    // IndexedDB's "unavailable in this environment" fallback path to report on.
    isPersistent: () => true,
  };
}
