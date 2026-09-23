import { describe, expect, it } from 'vitest';
import {
  _resetIndexedDbPoolForTests,
  createIndexedDbStorageAdapter,
  createMemoryStorageAdapter,
  recordIdOf,
} from '../../src/core/storageAdapter.js';

describe('createMemoryStorageAdapter', () => {
  it('supports put/get/getAll/delete/clear/count and is never persistent', async () => {
    const adapter = createMemoryStorageAdapter();
    expect(adapter.isPersistent()).toBe(false);

    await adapter.put('items', { id: 'a', status: 'pending' });
    await adapter.put('items', { id: 'b', status: 'done' });

    expect(await adapter.get('items', 'a')).toEqual({ id: 'a', status: 'pending' });
    expect(await adapter.count('items')).toBe(2);
    expect(await adapter.getAll('items', { indexName: 'status', query: 'pending' })).toHaveLength(
      1,
    );

    await adapter.delete('items', 'a');
    expect(await adapter.get('items', 'a')).toBeUndefined();

    await adapter.clear('items');
    expect(await adapter.count('items')).toBe(0);
  });

  it('getAll without an index filter returns every record in the store', async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.put('items', { id: 'a' });
    await adapter.put('items', { id: 'b' });

    expect(await adapter.getAll('items')).toHaveLength(2);
  });
});

describe('recordIdOf', () => {
  it('falls back to a "key" field for stores keyed like lowdata\'s meta store', () => {
    expect(recordIdOf({ key: 'lastSyncAt', value: 123 })).toBe('lastSyncAt');
  });

  it('falls back to a "submissionId" field for stores keyed like lowdata\'s formDrafts store', () => {
    expect(recordIdOf({ submissionId: 'sub-1', formId: 'f1' })).toBe('sub-1');
  });
});

describe('createIndexedDbStorageAdapter', () => {
  const stores = [
    { name: 'queue', keyPath: 'id', indexes: [{ name: 'status', keyPath: 'status' }] },
  ];

  it('persists via IndexedDB and reports isPersistent() true', async () => {
    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-test-${Math.random()}`,
      stores,
    });

    await adapter.put('queue', { id: '1', status: 'pending' });
    expect(await adapter.get('queue', '1')).toEqual({ id: '1', status: 'pending' });
    expect(adapter.isPersistent()).toBe(true);

    await adapter.destroy?.();
  });

  it("two different dbName adapters never see each other's data (namespace isolation)", async () => {
    const a = createIndexedDbStorageAdapter({ dbName: `ns-a-${Math.random()}`, stores });
    const b = createIndexedDbStorageAdapter({ dbName: `ns-b-${Math.random()}`, stores });

    await a.put('queue', { id: 'shared-id', status: 'pending', owner: 'a' });
    await b.put('queue', { id: 'shared-id', status: 'pending', owner: 'b' });

    expect(await a.get<{ owner: string }>('queue', 'shared-id')).toEqual(
      expect.objectContaining({ owner: 'a' }),
    );
    expect(await b.get<{ owner: string }>('queue', 'shared-id')).toEqual(
      expect.objectContaining({ owner: 'b' }),
    );

    await a.destroy?.();
    await b.destroy?.();
  });

  it('falls back to memory (isPersistent() false) when IndexedDB is unavailable, without throwing', async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error simulating an environment without IndexedDB
    delete globalThis.indexedDB;

    const errors: Array<{ scope: string }> = [];
    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-test-noidb-${Math.random()}`,
      stores,
      onError: (_e, ctx) => errors.push(ctx),
    });

    await adapter.put('queue', { id: '1', status: 'pending' });
    expect(adapter.isPersistent()).toBe(false);
    expect(await adapter.get('queue', '1')).toEqual({ id: '1', status: 'pending' });
    expect(errors).toContainEqual({ scope: 'db-open' });

    globalThis.indexedDB = original;
  });

  it('proactively reports a "quota" error when navigator.storage.estimate() reports low headroom', async () => {
    const originalStorage = (navigator as unknown as { storage?: unknown }).storage;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ quota: 1_000, usage: 999 }) },
    });

    const errors: Array<{ scope: string }> = [];
    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-test-quota-${Math.random()}`,
      stores,
      quotaWarningThresholdBytes: 500,
      onError: (_e, ctx) => errors.push(ctx),
    });

    await adapter.put('queue', { id: '1', status: 'pending' });
    // The quota check is fire-and-forget alongside the write — give its microtask a tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toContainEqual({ scope: 'quota' });
    await adapter.destroy?.();

    Object.defineProperty(navigator, 'storage', { configurable: true, value: originalStorage });
  });

  it('destroy() closes the connection so a subsequent deleteDatabase does not hang blocked', async () => {
    const dbName = `adapter-test-destroy-${Math.random()}`;
    const adapter = createIndexedDbStorageAdapter({ dbName, stores });
    await adapter.put('queue', { id: '1', status: 'pending' });

    await adapter.destroy?.();

    const deleted = await new Promise<'success' | 'blocked'>((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve('success');
      req.onblocked = () => resolve('blocked');
      req.onerror = () => resolve('blocked');
    });
    expect(deleted).toBe('success');
  });

  it('supports delete/clear/count/getAll-with-index through the real IndexedDB-backed adapter', async () => {
    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-crud-${Math.random()}`,
      stores,
    });

    await adapter.put('queue', { id: '1', status: 'pending' });
    await adapter.put('queue', { id: '2', status: 'done' });
    await adapter.put('queue', { id: '3', status: 'pending' });

    expect(await adapter.count('queue')).toBe(3);
    expect(await adapter.getAll('queue', { indexName: 'status', query: 'pending' })).toHaveLength(
      2,
    );

    await adapter.delete('queue', '2');
    expect(await adapter.count('queue')).toBe(2);
    expect(await adapter.get('queue', '2')).toBeUndefined();

    await adapter.clear('queue');
    expect(await adapter.count('queue')).toBe(0);

    await adapter.destroy?.();
  });

  it('an operation-level failure (unique-index violation) falls back to memory for that call only, without disabling persistence', async () => {
    const uniqueStores = [
      { name: 'queue', keyPath: 'id', indexes: [{ name: 'email', keyPath: 'email', unique: true }] },
    ];
    const errors: Array<{ scope: string }> = [];
    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-txfail-${Math.random()}`,
      stores: uniqueStores,
      onError: (_e, ctx) => errors.push(ctx),
    });

    await adapter.put('queue', { id: '1', email: 'a@example.com' });
    await adapter.put('queue', { id: '2', email: 'a@example.com' }); // violates unique index -> tx aborts

    expect(errors).toContainEqual({ scope: 'db-operation' });
    expect(adapter.isPersistent()).toBe(true); // one failed operation is not "IndexedDB unavailable"

    // Unlike createLocalStorageAdapter's merged reads, this per-call operation fallback is *not*
    // merged back into later get()/getAll() calls: those go straight to IndexedDB again and succeed
    // (finding nothing), so the record that fell back to memory here is not reachable through the
    // adapter afterward. Documenting the actual behavior, not just the happy path.
    expect(await adapter.get('queue', '2')).toBeUndefined();
    expect(await adapter.count('queue')).toBe(1);

    await adapter.destroy?.();
  });

  it('skips the proactive quota check without throwing when navigator.storage is unavailable', async () => {
    const originalStorage = (navigator as unknown as { storage?: unknown }).storage;
    Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });

    const errors: Array<{ scope: string }> = [];
    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-noestimate-${Math.random()}`,
      stores,
      onError: (_e, ctx) => errors.push(ctx),
    });

    await adapter.put('queue', { id: '1', status: 'pending' });
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).not.toContainEqual({ scope: 'quota' });
    await adapter.destroy?.();

    Object.defineProperty(navigator, 'storage', { configurable: true, value: originalStorage });
  });

  it('silently ignores a rejected navigator.storage.estimate() call', async () => {
    const originalStorage = (navigator as unknown as { storage?: unknown }).storage;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => {
          throw new Error('estimate failed');
        },
      },
    });

    const errors: Array<{ scope: string }> = [];
    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-estimatethrows-${Math.random()}`,
      stores,
      onError: (_e, ctx) => errors.push(ctx),
    });

    await adapter.put('queue', { id: '1', status: 'pending' });
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toHaveLength(0);
    await adapter.destroy?.();

    Object.defineProperty(navigator, 'storage', { configurable: true, value: originalStorage });
  });

  it('disables the proactive quota check when quotaWarningThresholdBytes is 0', async () => {
    const originalStorage = (navigator as unknown as { storage?: unknown }).storage;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ quota: 1_000, usage: 999 }) },
    });

    const errors: Array<{ scope: string }> = [];
    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-quotadisabled-${Math.random()}`,
      stores,
      quotaWarningThresholdBytes: 0,
      onError: (_e, ctx) => errors.push(ctx),
    });

    await adapter.put('queue', { id: '1', status: 'pending' });
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toHaveLength(0);
    await adapter.destroy?.();

    Object.defineProperty(navigator, 'storage', { configurable: true, value: originalStorage });
  });

  it('throttles the proactive quota check so back-to-back writes only warn once', async () => {
    const originalStorage = (navigator as unknown as { storage?: unknown }).storage;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ quota: 1_000, usage: 999 }) },
    });

    const errors: Array<{ scope: string }> = [];
    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-throttle-${Math.random()}`,
      stores,
      quotaWarningThresholdBytes: 500,
      onError: (_e, ctx) => errors.push(ctx),
    });

    await adapter.put('queue', { id: '1', status: 'pending' });
    await adapter.put('queue', { id: '2', status: 'pending' });
    await new Promise((r) => setTimeout(r, 0));

    expect(errors.filter((e) => e.scope === 'quota')).toHaveLength(1);
    await adapter.destroy?.();

    Object.defineProperty(navigator, 'storage', { configurable: true, value: originalStorage });
  });

  it('pools connections by dbName: destroying one of two adapters sharing a dbName keeps the other working', async () => {
    const dbName = `adapter-pool-share-${Math.random()}`;
    const a = createIndexedDbStorageAdapter({ dbName, stores });
    const b = createIndexedDbStorageAdapter({ dbName, stores });

    await a.put('queue', { id: '1', status: 'pending' });
    await a.destroy?.();

    // b still works — the shared connection wasn't closed out from under it by a's destroy().
    expect(await b.get('queue', '1')).toEqual({ id: '1', status: 'pending' });
    await b.put('queue', { id: '2', status: 'done' });
    expect(await b.get('queue', '2')).toEqual({ id: '2', status: 'done' });

    await b.destroy?.();

    const deleted = await new Promise<'success' | 'blocked'>((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve('success');
      req.onblocked = () => resolve('blocked');
      req.onerror = () => resolve('blocked');
    });
    expect(deleted).toBe('success'); // both adapters released — the shared connection actually closed
  });

  it('destroy() on a fully-degraded (memory-fallback) adapter does not throw', async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error simulating an environment without IndexedDB
    delete globalThis.indexedDB;

    const adapter = createIndexedDbStorageAdapter({
      dbName: `adapter-degraded-destroy-${Math.random()}`,
      stores,
    });
    await adapter.put('queue', { id: '1', status: 'pending' });

    await expect(adapter.destroy?.()).resolves.toBeUndefined();

    globalThis.indexedDB = original;
  });

  it('_resetIndexedDbPoolForTests is a no-op for a dbName that was never opened', async () => {
    await expect(
      _resetIndexedDbPoolForTests(`never-opened-${Math.random()}`),
    ).resolves.toBeUndefined();
  });
});
