import {
  _resetSharedDbForTests,
  LOWDATA_DB_NAME,
  LOWDATA_DB_VERSION,
  LOWDATA_STORES,
  openDatabase,
} from '../../src/core/idb.js';

/**
 * Opens a fresh test database using lowdata's real production store schema (queue/meta/formDrafts)
 * — reusing `LOWDATA_STORES` instead of hand-declaring stores/indexes per test file keeps test
 * fixtures from silently drifting out of sync with the actual schema.
 */
export function openTestDb(dbName: string): () => Promise<IDBDatabase> {
  return () => openDatabase(dbName, LOWDATA_DB_VERSION, LOWDATA_STORES);
}

/**
 * Resets the shared (module-singleton) lowdata IndexedDB connection used by `getSharedDb()`
 * consumers (`RequestQueue` via `createLowdataClient`, form draft storage). Call in
 * `beforeEach`/`afterEach` around any test that uses the default client or `createOfflineForm`
 * without an injected db, so tests don't leak state into each other or hang on a stale open
 * connection blocking `deleteDatabase`.
 */
export async function resetSharedDb(): Promise<void> {
  await _resetSharedDbForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(LOWDATA_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
