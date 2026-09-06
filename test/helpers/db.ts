import {
  LOWDATA_DB_NAME,
  LOWDATA_DB_VERSION,
  LOWDATA_STORES,
  openDatabase,
} from '../../src/core/idb.js';
import {
  _resetIndexedDbPoolForTests,
  createIndexedDbStorageAdapter,
} from '../../src/core/storageAdapter.js';
import type { StorageAdapter } from '../../src/core/storageAdapter.js';

/**
 * Opens a fresh test database using lowdata's real production store schema (queue/meta/formDrafts)
 * — reusing `LOWDATA_STORES` instead of hand-declaring stores/indexes per test file keeps test
 * fixtures from silently drifting out of sync with the actual schema.
 */
export function openTestDb(dbName: string): () => Promise<IDBDatabase> {
  return () => openDatabase(dbName, LOWDATA_DB_VERSION, LOWDATA_STORES);
}

/** Same as `openTestDb`, but wrapped as a `StorageAdapter` — what `RequestQueue`/`SyncManager` actually take now. */
export function openTestAdapter(dbName: string): StorageAdapter {
  return createIndexedDbStorageAdapter({
    dbName,
    dbVersion: LOWDATA_DB_VERSION,
    stores: LOWDATA_STORES,
  });
}

/**
 * Resets the pooled, reference-counted IndexedDB connection to lowdata's default (unnamespaced)
 * `'lowdata'` database — the one every default `createLowdataClient()`/`createOfflineForm()` in
 * these tests shares. Call in `beforeEach`/`afterEach` around any test that uses a default client
 * or form without an injected namespace/storage, so tests don't leak queue/draft state into each
 * other or hang on a stale open connection blocking `deleteDatabase`.
 */
export async function resetSharedDb(): Promise<void> {
  await _resetIndexedDbPoolForTests(LOWDATA_DB_NAME);
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(LOWDATA_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
