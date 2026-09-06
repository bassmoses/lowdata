import { describe, expect, it } from 'vitest';
import { createAsyncStorageAdapter } from '../../src/core/asyncStorageAdapter.js';
import type { AsyncStorageLike } from '../../src/core/asyncStorageAdapter.js';

/** In-memory double for @react-native-async-storage/async-storage's default export shape. */
function createFakeAsyncStorage(): AsyncStorageLike {
  const store = new Map<string, string>();
  return {
    async getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async setItem(key, value) {
      store.set(key, value);
    },
    async removeItem(key) {
      store.delete(key);
    },
    async getAllKeys() {
      return Array.from(store.keys());
    },
    async multiRemove(keys) {
      for (const key of keys) store.delete(key);
    },
  };
}

describe('createAsyncStorageAdapter', () => {
  it('supports put/get/getAll/delete/clear/count against a store', async () => {
    const adapter = createAsyncStorageAdapter(createFakeAsyncStorage());

    await adapter.put('queue', { id: 'a', status: 'pending' });
    await adapter.put('queue', { id: 'b', status: 'done' });

    expect(await adapter.get('queue', 'a')).toEqual({ id: 'a', status: 'pending' });
    expect(await adapter.count('queue')).toBe(2);
    expect(await adapter.getAll('queue')).toHaveLength(2);

    await adapter.delete('queue', 'a');
    expect(await adapter.get('queue', 'a')).toBeUndefined();
    expect(await adapter.count('queue')).toBe(1);

    await adapter.clear('queue');
    expect(await adapter.count('queue')).toBe(0);
  });

  it("filters getAll() by an index field, matching the IndexedDB adapter's contract", async () => {
    const adapter = createAsyncStorageAdapter(createFakeAsyncStorage());
    await adapter.put('queue', { id: '1', status: 'pending' });
    await adapter.put('queue', { id: '2', status: 'done' });
    await adapter.put('queue', { id: '3', status: 'pending' });

    const pending = await adapter.getAll('queue', { indexName: 'status', query: 'pending' });
    expect(pending).toHaveLength(2);
  });

  it('keeps separate stores (queue/meta/formDrafts) from colliding on id', async () => {
    const adapter = createAsyncStorageAdapter(createFakeAsyncStorage());
    await adapter.put('queue', { id: 'shared', value: 'from-queue' });
    await adapter.put('meta', { id: 'shared', value: 'from-meta' });

    expect(await adapter.get<{ value: string }>('queue', 'shared')).toEqual(
      expect.objectContaining({ value: 'from-queue' }),
    );
    expect(await adapter.get<{ value: string }>('meta', 'shared')).toEqual(
      expect.objectContaining({ value: 'from-meta' }),
    );

    await adapter.clear('queue');
    expect(await adapter.get('queue', 'shared')).toBeUndefined();
    expect(await adapter.get('meta', 'shared')).toBeDefined(); // clear() on one store never touches another
  });

  it('isolates two different namespaces on the same underlying storage (multi-tenant/per-event scoping)', async () => {
    const shared = createFakeAsyncStorage();
    const eventA = createAsyncStorageAdapter(shared, 'event-a');
    const eventB = createAsyncStorageAdapter(shared, 'event-b');

    await eventA.put('queue', { id: 'shared-id', owner: 'a' });
    await eventB.put('queue', { id: 'shared-id', owner: 'b' });

    expect(await eventA.get<{ owner: string }>('queue', 'shared-id')).toEqual(
      expect.objectContaining({ owner: 'a' }),
    );
    expect(await eventB.get<{ owner: string }>('queue', 'shared-id')).toEqual(
      expect.objectContaining({ owner: 'b' }),
    );
    expect(await eventA.count('queue')).toBe(1); // never sees event B's item
  });

  it('falls back to sequential removeItem when multiRemove is unavailable', async () => {
    const base = createFakeAsyncStorage();
    delete base.multiRemove;
    const adapter = createAsyncStorageAdapter(base);

    await adapter.put('queue', { id: '1' });
    await adapter.put('queue', { id: '2' });
    await adapter.clear('queue');

    expect(await adapter.count('queue')).toBe(0);
  });

  it('reports isPersistent() true — AsyncStorage always persists, unlike the IndexedDB fallback path', () => {
    const adapter = createAsyncStorageAdapter(createFakeAsyncStorage());
    expect(adapter.isPersistent()).toBe(true);
  });
});
