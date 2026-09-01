import { describe, expect, it } from 'vitest';
import {
  idbClear,
  idbCount,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  isIndexedDbAvailable,
  openDatabase,
} from '../../src/core/idb.js';

describe('idb', () => {
  it('reports IndexedDB as available under the fake-indexeddb polyfill', () => {
    expect(isIndexedDbAvailable()).toBe(true);
  });

  it('supports put/get/getAll/delete/clear/count against a store', async () => {
    const dbName = `test-db-${Math.random()}`;
    const db = await openDatabase(dbName, 1, [{ name: 'items', keyPath: 'id' }]);

    await idbPut(db, 'items', { id: 'a', value: 1 });
    await idbPut(db, 'items', { id: 'b', value: 2 });

    expect(await idbGet(db, 'items', 'a')).toEqual({ id: 'a', value: 1 });
    expect(await idbCount(db, 'items')).toBe(2);
    expect(await idbGetAll(db, 'items')).toHaveLength(2);

    await idbDelete(db, 'items', 'a');
    expect(await idbGet(db, 'items', 'a')).toBeUndefined();
    expect(await idbCount(db, 'items')).toBe(1);

    await idbClear(db, 'items');
    expect(await idbCount(db, 'items')).toBe(0);

    db.close();
    indexedDB.deleteDatabase(dbName);
  });

  it('supports querying via a secondary index', async () => {
    const dbName = `test-db-idx-${Math.random()}`;
    const db = await openDatabase(dbName, 1, [
      { name: 'items', keyPath: 'id', indexes: [{ name: 'status', keyPath: 'status' }] },
    ]);
    await idbPut(db, 'items', { id: '1', status: 'pending' });
    await idbPut(db, 'items', { id: '2', status: 'done' });
    await idbPut(db, 'items', { id: '3', status: 'pending' });

    const pending = await idbGetAll(db, 'items', { indexName: 'status', query: 'pending' });
    expect(pending).toHaveLength(2);

    db.close();
    indexedDB.deleteDatabase(dbName);
  });

  it('rejects opening a database when IndexedDB is unavailable', async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error simulating an environment without IndexedDB (e.g. SSR)
    delete globalThis.indexedDB;

    expect(isIndexedDbAvailable()).toBe(false);
    await expect(openDatabase('x', 1, [])).rejects.toThrow();

    globalThis.indexedDB = original;
  });
});
