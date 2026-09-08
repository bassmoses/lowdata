import { recordIdOf, createMemoryStorageAdapter, type StorageAdapter } from './storageAdapter.js';
import type { LowdataErrorHandler } from './types.js';

export interface LocalStorageAdapterOptions {
  /**
   * The underlying synchronous key-value store. Defaults to `globalThis.localStorage`. Injectable
   * for tests, or for a host that wants the same key-prefixing/index-filtering behavior over
   * `sessionStorage` or another `Storage`-shaped object instead.
   */
  storage?: Storage;
  /**
   * Namespaces keys the same way `createAsyncStorageAdapter`'s `namespace` argument does — isolate
   * one client's rows from another sharing the same origin's `localStorage` (e.g. one namespace
   * per tenant on a shared device). Defaults to `'lowdata'`. Note every lowdata namespace still
   * shares the *same* underlying `localStorage`; keep any app-owned keys outside the
   * `` `${namespace}:${store}:` `` prefix so they can't collide with it.
   */
  namespace?: string;
  onError?: LowdataErrorHandler;
  /**
   * Below this many (estimated) free bytes, `put()` proactively reports
   * `onError(..., { scope: 'quota' })`. Default 256 KB — deliberately much lower than
   * `createIndexedDbStorageAdapter`'s 5 MB default: IndexedDB's real-world quota is commonly
   * gigabytes and directly queryable via `navigator.storage.estimate()`, so a 5 MB warning there is
   * a small fraction of the budget. `localStorage`'s total *origin* quota is itself typically only
   * ~5-10 MB across current browsers, with no equivalent per-origin estimate API — 256 KB is
   * roughly the same proportional warning-to-budget ratio, scaled to this store's much smaller,
   * heuristically-estimated ceiling. Set to `0` to disable.
   */
  quotaWarningThresholdBytes?: number;
}

const DEFAULT_NAMESPACE = 'lowdata';
const DEFAULT_QUOTA_WARNING_BYTES = 256 * 1024; // 256 KB — see doc comment above
const QUOTA_CHECK_INTERVAL_MS = 10_000; // matches createIndexedDbStorageAdapter's own interval
const PROBE_KEY = '__lowdata_probe__';

/**
 * There is no `navigator.storage.estimate()` equivalent scoped to `localStorage` specifically —
 * unlike IndexedDB, the browser gives no reliable "how much of *my* budget is left" answer. This
 * estimates it by summing every key+value's UTF-16 length currently stored under `storage`
 * (lowdata's own keys *and* anything else sharing the same origin's localStorage) against an
 * assumed typical total quota. This is a heuristic, not a guarantee — real per-browser ceilings
 * vary (roughly 5-10 MB) — but it's the only signal available without risking a destructive
 * write-until-it-throws probe.
 */
const ASSUMED_TOTAL_QUOTA_BYTES = 5 * 1024 * 1024; // 5 MB — the de facto floor across current browsers

function estimateRemainingBytes(storage: Storage): number | undefined {
  try {
    let usedChars = 0;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key == null) continue;
      usedChars += key.length + (storage.getItem(key)?.length ?? 0);
    }
    return ASSUMED_TOTAL_QUOTA_BYTES - usedChars * 2; // 2 bytes per UTF-16 code unit
  } catch {
    return undefined;
  }
}

function getDefaultStorage(): Storage | undefined {
  try {
    // Merely *accessing* `.localStorage` throws in some locked-down browsers/policies (not just
    // using it) — treat that identically to "not available", same as `isIndexedDbAvailable()`.
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * `StorageAdapter` over synchronous `localStorage` (or anything `Storage`-shaped) — a portability
 * fallback for hosts where IndexedDB is unavailable or crippled (Safari private browsing, some
 * locked-down in-app webviews) but `localStorage` still works. **Not a replacement for IndexedDB at
 * scale**: `localStorage`'s real-world quota is only ~5-10 MB total per origin, and every read/write
 * is synchronous/blocking — fine for a small offline queue, not a general persistence layer.
 *
 * Modeled on `createAsyncStorageAdapter`: no native concept of separate "stores" or secondary
 * indexes, so both are emulated — each store's keys are prefixed (`` `${namespace}:${store}:` ``),
 * and `getAll()`'s optional index filter is a linear scan+filter in JS after reading every key in
 * that store, which is fine for an offline queue's realistic size, not a query engine.
 */
export function createLocalStorageAdapter(
  options: LocalStorageAdapterOptions = {},
): StorageAdapter {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const quotaThreshold = options.quotaWarningThresholdBytes ?? DEFAULT_QUOTA_WARNING_BYTES;
  const storage = options.storage ?? getDefaultStorage();
  const memory = createMemoryStorageAdapter();

  function keyFor(store: string, id: string): string {
    return `${namespace}:${store}:${id}`;
  }
  function prefixFor(store: string): string {
    return `${namespace}:${store}:`;
  }
  function keysInStore(store: string): string[] {
    if (!storage) return [];
    const prefix = prefixFor(store);
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  // `writesAvailable` gates *writes* only — whether `put()` currently attempts `localStorage` at
  // all, versus going straight to the in-memory fallback. It starts (and stays) `false` if
  // `storage` doesn't exist, or fails an up-front write probe (SSR, policy-disabled, or Safari
  // private browsing, where the object exists but every write throws with quota 0); it also flips
  // `false`, permanently, the first time a later write throws (the store filling up mid-session).
  //
  // Deliberately does NOT gate reads/deletes: `getItem`/`key`/`length`/`removeItem` don't consume
  // quota and essentially never throw the way `setItem` does, so a write failure has no bearing on
  // whether *already-persisted* records are still safely readable. Gating reads on the same flag
  // (an earlier version of this adapter did) would make every record written before the failure
  // silently invisible — not deleted, just unreachable via `get`/`getAll`/`count` — which for an
  // offline queue looks exactly like "my pending items vanished". Instead, every read/delete/clear
  // below always consults `localStorage` (when present) for whatever's actually there, and merges
  // in whatever `put()` had to route to `memory` after write-availability was lost, deduping by id
  // in memory's favor (the more recent write, since it only lands there *after* a real localStorage
  // write for that same id has already failed).
  let writesAvailable = false;

  if (storage) {
    try {
      storage.setItem(PROBE_KEY, '1');
      storage.removeItem(PROBE_KEY);
      writesAvailable = true;
    } catch (error) {
      options.onError?.(error, { scope: 'db-open' });
    }
  } else {
    options.onError?.(new Error('lowdata: localStorage is not available in this environment'), {
      scope: 'db-open',
    });
  }

  function fallOver(error: unknown): void {
    if (!writesAvailable) return;
    writesAvailable = false;
    options.onError?.(error, { scope: 'db-operation' });
  }

  let lastQuotaCheckAt = 0;
  function warnIfQuotaLow(): void {
    if (!writesAvailable || quotaThreshold <= 0 || !options.onError) return;
    const now = Date.now();
    if (now - lastQuotaCheckAt < QUOTA_CHECK_INTERVAL_MS) return;
    lastQuotaCheckAt = now;
    const remaining = estimateRemainingBytes(storage!);
    if (remaining !== undefined && remaining < quotaThreshold) {
      options.onError(
        new Error(
          `lowdata: localStorage quota nearly exhausted (~${remaining} bytes free, threshold ${quotaThreshold})`,
        ),
        { scope: 'quota' },
      );
    }
  }

  /** Every record in `store`, read directly from `localStorage` — empty if `storage` is absent. */
  function readAllFromStorage<T>(store: string): T[] {
    return keysInStore(store)
      .map((key) => storage!.getItem(key))
      .filter((raw): raw is string => raw != null)
      .map((raw) => JSON.parse(raw) as T);
  }

  /**
   * Merges `localStorage`'s copy of `store` with whatever `memory` holds for it (records that
   * landed there because a `put()` fell back after `writesAvailable` turned `false`), preferring
   * memory's version if the same id somehow exists in both — that can only happen if a later
   * `put()` for an id already in `localStorage` failed and fell back, leaving the `localStorage`
   * copy stale.
   */
  async function getAllMerged<T>(store: string): Promise<T[]> {
    const fromStorage = readAllFromStorage<T>(store);
    const fromMemory = await memory.getAll<T>(store);
    if (fromMemory.length === 0) return fromStorage;
    const memoryIds = new Set(fromMemory.map((record) => recordIdOf(record)));
    return [...fromStorage.filter((record) => !memoryIds.has(recordIdOf(record))), ...fromMemory];
  }

  return {
    async put<T>(store: string, value: T): Promise<void> {
      const id = recordIdOf(value);
      if (writesAvailable) {
        warnIfQuotaLow();
        try {
          storage!.setItem(keyFor(store, id), JSON.stringify(value));
          // A stale fallback copy of this same id (from an earlier degraded write) would otherwise
          // shadow-and-be-shadowed-by this fresh, successful one in getAllMerged()'s dedup — drop it.
          await memory.delete(store, id);
          return;
        } catch (error) {
          fallOver(error);
          // fall through to the memory fallback below
        }
      }
      await memory.put(store, value);
    },
    async get<T>(store: string, key: string): Promise<T | undefined> {
      if (storage) {
        const raw = storage.getItem(keyFor(store, key));
        if (raw != null) return JSON.parse(raw) as T;
      }
      return memory.get<T>(store, key);
    },
    async getAll<T>(
      store: string,
      queryOptions?: { indexName?: string; query?: unknown },
    ): Promise<T[]> {
      const merged = await getAllMerged<T>(store);
      if (!queryOptions?.indexName) return merged;
      const indexName = queryOptions.indexName;
      return merged.filter(
        (record) => (record as Record<string, unknown>)[indexName] === queryOptions.query,
      );
    },
    async delete(store: string, key: string): Promise<void> {
      if (storage) storage.removeItem(keyFor(store, key));
      await memory.delete(store, key);
    },
    async clear(store: string): Promise<void> {
      if (storage) for (const key of keysInStore(store)) storage.removeItem(key);
      await memory.clear(store);
    },
    async count(store: string): Promise<number> {
      return (await getAllMerged(store)).length;
    },
    // Reflects whether *new writes* are currently reaching real localStorage, not whether any data
    // is readable — mirrors the IndexedDB adapter's "was the last write actually durable" intent,
    // scoped correctly to writes only (see the `writesAvailable` doc comment above).
    isPersistent: () => writesAvailable,
  };
}
