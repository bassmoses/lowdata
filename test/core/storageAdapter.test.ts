import { describe, expect, it } from 'vitest';
import {
  createIndexedDbStorageAdapter,
  createMemoryStorageAdapter,
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

  it('two different dbName adapters never see each other\'s data (namespace isolation)', async () => {
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
});
