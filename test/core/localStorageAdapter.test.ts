import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalStorageAdapter } from '../../src/core/localStorageAdapter.js';

/** Deterministic in-memory double for the `Storage` interface — full control over throw timing. */
function createFakeStorage(opts: { throwOnSetItem?: boolean } = {}): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      if (opts.throwOnSetItem) throw new DOMException('quota exceeded', 'QuotaExceededError');
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  } as unknown as Storage;
}

afterEach(() => {
  // jsdom's real window.localStorage persists across tests within one file — clear it so tests
  // that deliberately don't inject `storage` (exercising the `globalThis.localStorage` default)
  // never see leftovers from an earlier test.
  window.localStorage.clear();
});

describe('createLocalStorageAdapter', () => {
  it('supports put/get/getAll-with-index/delete/clear/count against a store', async () => {
    const adapter = createLocalStorageAdapter({ storage: createFakeStorage() });

    await adapter.put('queue', { id: '1', status: 'pending' });
    await adapter.put('queue', { id: '2', status: 'done' });
    await adapter.put('queue', { id: '3', status: 'pending' });

    expect(await adapter.get('queue', '1')).toEqual({ id: '1', status: 'pending' });
    expect(await adapter.count('queue')).toBe(3);
    expect(await adapter.getAll('queue', { indexName: 'status', query: 'pending' })).toHaveLength(
      2,
    );

    await adapter.delete('queue', '1');
    expect(await adapter.get('queue', '1')).toBeUndefined();
    expect(await adapter.count('queue')).toBe(2);

    await adapter.clear('queue');
    expect(await adapter.count('queue')).toBe(0);
    expect(adapter.isPersistent()).toBe(true);
  });

  it('isolates two namespaces sharing the same underlying storage (multi-tenant scoping)', async () => {
    const shared = createFakeStorage();
    const eventA = createLocalStorageAdapter({ storage: shared, namespace: 'event-a' });
    const eventB = createLocalStorageAdapter({ storage: shared, namespace: 'event-b' });

    await eventA.put('queue', { id: 'shared-id', owner: 'a' });
    await eventB.put('queue', { id: 'shared-id', owner: 'b' });

    expect(await eventA.get<{ owner: string }>('queue', 'shared-id')).toEqual(
      expect.objectContaining({ owner: 'a' }),
    );
    expect(await eventB.get<{ owner: string }>('queue', 'shared-id')).toEqual(
      expect.objectContaining({ owner: 'b' }),
    );
    expect(await eventA.count('queue')).toBe(1); // never sees event B's item

    await eventA.clear('queue');
    expect(await eventA.count('queue')).toBe(0);
    expect(await eventB.count('queue')).toBe(1); // clear() on one namespace never touches the other
  });

  it('degrades to memory (isPersistent() false), without throwing, when localStorage is unavailable at construction', async () => {
    // `storage: undefined` alone isn't enough to simulate this — the adapter's own `??` fallback
    // would just pick up jsdom's real `window.localStorage`. Actually remove the global, the way
    // SSR or a policy-disabled browser genuinely would.
    vi.stubGlobal('localStorage', undefined);
    try {
      const errors: Array<{ scope: string }> = [];
      const adapter = createLocalStorageAdapter({ onError: (_e, ctx) => errors.push(ctx) });

      expect(adapter.isPersistent()).toBe(false);
      await adapter.put('queue', { id: '1', status: 'pending' });
      expect(await adapter.get('queue', '1')).toEqual({ id: '1', status: 'pending' }); // still works, via memory
      expect(errors).toContainEqual({ scope: 'db-open' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('degrades to memory when the up-front availability probe itself throws (quota exceeded), and stays degraded', async () => {
    const errors: Array<{ scope: string }> = [];
    const storage = createFakeStorage({ throwOnSetItem: true });
    // Constructing over an already-throwing storage: the up-front probe itself fails, so this
    // adapter never reports `isPersistent() === true` at all.
    const adapter = createLocalStorageAdapter({ storage, onError: (_e, ctx) => errors.push(ctx) });

    expect(adapter.isPersistent()).toBe(false);
    expect(errors).toContainEqual({ scope: 'db-open' });

    await adapter.put('queue', { id: '1' });
    expect(await adapter.get('queue', '1')).toEqual({ id: '1' }); // memory fallback still serves reads
  });

  it('keeps previously-persisted items visible after a later write degrades to memory', async () => {
    const errors: Array<{ scope: string }> = [];
    const opts: { throwOnSetItem?: boolean } = {};
    const storage = createFakeStorage(opts);
    const adapter = createLocalStorageAdapter({ storage, onError: (_e, ctx) => errors.push(ctx) });

    await adapter.put('queue', { id: 'old', status: 'pending' }); // succeeds, lands in real storage
    expect(adapter.isPersistent()).toBe(true);

    opts.throwOnSetItem = true; // simulate localStorage filling up mid-session
    await adapter.put('queue', { id: 'new', status: 'pending' }); // fails, falls back to memory
    expect(adapter.isPersistent()).toBe(false);
    expect(errors).toContainEqual({ scope: 'db-operation' });

    // Both the earlier (real-storage) item and the later (memory-fallback) one stay visible —
    // a write failure must not orphan data that was already safely persisted.
    const all = await adapter.getAll<{ id: string }>('queue');
    expect(all.map((i) => i.id).sort()).toEqual(['new', 'old']);
    expect(await adapter.count('queue')).toBe(2);
    expect(await adapter.get('queue', 'old')).toEqual({ id: 'old', status: 'pending' });
  });
});
