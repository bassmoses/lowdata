import { recordIdOf, type StorageAdapter } from './storageAdapter.js';

/**
 * The subset of `@react-native-async-storage/async-storage`'s API this adapter actually needs —
 * described structurally rather than imported, so `lowdata` never takes a real dependency (peer or
 * otherwise) on React Native or that package. Its default export already satisfies this shape, so
 * `createAsyncStorageAdapter(AsyncStorage)` just works; any other key-value store with the same
 * shape (a polyfill, a test double) works identically.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  /**
   * Used opportunistically by `getAll()`/`count()` when available — each individual `getItem` is
   * its own round-trip across the JS↔native bridge on a real device, so batching every read in a
   * store into one `multiGet` call (real AsyncStorage's own API) matters far more here than it
   * would against an in-memory or IndexedDB backend. Falls back to `Promise.all(getItem)` otherwise.
   */
  multiGet?(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
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
 * context can't leak or cross-send another context's queued writes. Note this also means every
 * lowdata namespace shares the *same* underlying AsyncStorage — a key some other, non-lowdata part
 * of the app writes directly (not through this adapter) could theoretically collide with the
 * `` `${namespace}:${store}:` `` prefix; keep app-owned keys outside that pattern.
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
  async function keysInStore(store: string): Promise<string[]> {
    const prefix = prefixFor(store);
    const allKeys = await storage.getAllKeys();
    return allKeys.filter((key) => key.startsWith(prefix));
  }
  /** Reads every key in `keys`, batched via `multiGet` when the host provides it. */
  async function readAll(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    if (storage.multiGet) {
      const pairs = await storage.multiGet(keys);
      return pairs.map(([, value]) => value).filter((value): value is string => value != null);
    }
    const values = await Promise.all(keys.map((key) => storage.getItem(key)));
    return values.filter((value): value is string => value != null);
  }

  return {
    async put<T>(store: string, value: T): Promise<void> {
      await storage.setItem(keyFor(store, recordIdOf(value)), JSON.stringify(value));
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
      const raws = await readAll(keys);
      const records = raws.map((raw) => JSON.parse(raw) as T);
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
