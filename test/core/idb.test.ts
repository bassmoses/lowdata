import { describe, expect, it } from 'vitest';
import {
  createDbFallbackAccessor,
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

describe('createDbFallbackAccessor', () => {
  it('falls back to memory but stays persistent after a transient operation failure', async () => {
    const db = {} as IDBDatabase; // never actually touched by the run() callbacks below
    const accessor = createDbFallbackAccessor(async () => db);

    const result = await accessor.run(
      async () => {
        throw new Error('transient quota error');
      },
      () => 'fallback-value',
    );
    expect(result).toBe('fallback-value');
    expect(accessor.isPersistent()).toBe(true); // not a structural failure — still persistent

    // A later call still tries IndexedDB rather than being permanently disabled.
    const result2 = await accessor.run(
      async () => 'from-db',
      () => 'fallback-value',
    );
    expect(result2).toBe('from-db');
  });

  it('permanently falls back to memory once getDb() itself fails, without retrying it', async () => {
    let getDbCalls = 0;
    const accessor = createDbFallbackAccessor(async () => {
      getDbCalls++;
      throw new Error('cannot open database');
    });

    const result = await accessor.run(
      async () => 'from-db',
      () => 'fallback-value',
    );
    expect(result).toBe('fallback-value');
    expect(accessor.isPersistent()).toBe(false);

    await accessor.run(
      async () => 'from-db',
      () => 'fallback-value',
    );
    expect(getDbCalls).toBe(1); // second run() didn't call getDb() again
  });

  it('reports onError with the right scope for each failure kind', async () => {
    const openEvents: Array<{ scope: string }> = [];
    const openAccessor = createDbFallbackAccessor(
      async () => {
        throw new Error('open failed');
      },
      (_error, context) => openEvents.push(context),
    );
    await openAccessor.run(
      async () => 'x',
      () => 'fallback',
    );
    expect(openEvents).toEqual([{ scope: 'db-open' }]);

    const opEvents: Array<{ scope: string }> = [];
    const db = {} as IDBDatabase;
    const opAccessor = createDbFallbackAccessor(
      async () => db,
      (_error, context) => opEvents.push(context),
    );
    await opAccessor.run(
      async () => {
        throw new Error('operation failed');
      },
      () => 'fallback',
    );
    expect(opEvents).toEqual([{ scope: 'db-operation' }]);
  });
});
