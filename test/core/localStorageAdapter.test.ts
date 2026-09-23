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

  it('get() prefers the memory-fallback copy over a stale localStorage copy for the same id', async () => {
    // Regression test: get() used to check `storage` before `memory`, so overwriting an id that was
    // already in localStorage (writing new data that itself fails and falls back to memory) made
    // get() return the *stale* pre-failure value even though getAll()/count() already reported the
    // fresh one from memory — an inconsistency between single-key and bulk reads for the same store.
    const opts: { throwOnSetItem?: boolean } = {};
    const storage = createFakeStorage(opts);
    const adapter = createLocalStorageAdapter({ storage });

    await adapter.put('queue', { id: 'x', status: 'pending' }); // succeeds, lands in real storage
    opts.throwOnSetItem = true;
    await adapter.put('queue', { id: 'x', status: 'retrying' }); // same id, now falls back to memory

    expect(await adapter.get('queue', 'x')).toEqual({ id: 'x', status: 'retrying' });
    const all = await adapter.getAll<{ id: string; status: string }>('queue');
    expect(all).toEqual([{ id: 'x', status: 'retrying' }]); // not duplicated between storage and memory
  });

  it('degrades to memory when merely accessing globalThis.localStorage throws (e.g. some locked-down browsers/policies)', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('access denied', 'SecurityError');
      },
    });

    try {
      const errors: Array<{ scope: string }> = [];
      const adapter = createLocalStorageAdapter({ onError: (_e, ctx) => errors.push(ctx) });

      expect(adapter.isPersistent()).toBe(false);
      await adapter.put('queue', { id: '1', status: 'pending' });
      expect(await adapter.get('queue', '1')).toEqual({ id: '1', status: 'pending' }); // via memory
      expect(errors).toContainEqual({ scope: 'db-open' });
    } finally {
      if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('does not confuse similarly-prefixed store names (e.g. "queue" vs "queue2") when scanning keys', async () => {
    const adapter = createLocalStorageAdapter({ storage: createFakeStorage() });

    await adapter.put('queue', { id: '1' });
    await adapter.put('queue2', { id: '1' }); // same id, prefix-overlapping store name

    expect(await adapter.count('queue')).toBe(1);
    expect(await adapter.count('queue2')).toBe(1);

    await adapter.clear('queue');
    expect(await adapter.count('queue')).toBe(0);
    expect(await adapter.count('queue2')).toBe(1); // clearing "queue" must not sweep up "queue2"'s keys
  });

  describe('quota warning', () => {
    it('reports onError(..., { scope: "quota" }) once estimated remaining space drops below the threshold', async () => {
      const storage = createFakeStorage();
      const errors: Array<{ scope: string; error: unknown }> = [];
      // Threshold set just above the assumed 5 MB total quota so it fires against near-empty
      // storage too — isolates "does the estimate/threshold comparison actually fire" from having
      // to simulate megabytes of real data.
      const adapter = createLocalStorageAdapter({
        storage,
        quotaWarningThresholdBytes: 5 * 1024 * 1024 + 1,
        onError: (error, ctx) => errors.push({ scope: ctx.scope, error }),
      });

      await adapter.put('queue', { id: '1', status: 'pending' });

      const quotaEvents = errors.filter((e) => e.scope === 'quota');
      expect(quotaEvents).toHaveLength(1);
      expect(String(quotaEvents[0]?.error)).toMatch(/quota nearly exhausted/);
    });

    it('estimates remaining space from real stored key+value sizes and warns using the default 256 KB threshold', async () => {
      const storage = createFakeStorage();
      // Simulates another part of the app (or another lowdata namespace) having already filled
      // most of the shared origin quota — leaves ~243 KB of the assumed 5 MB total, under the
      // default 256 KB threshold, without needing an artificially low threshold.
      storage.setItem('other-app-data', 'x'.repeat(2_500_000));
      const errors: Array<{ scope: string }> = [];
      const adapter = createLocalStorageAdapter({ storage, onError: (_e, ctx) => errors.push(ctx) });

      await adapter.put('queue', { id: '1', status: 'pending' });

      expect(errors).toContainEqual({ scope: 'quota' });
    });

    it('throttles the quota warning so back-to-back writes only report it once', async () => {
      const storage = createFakeStorage();
      const errors: Array<{ scope: string }> = [];
      const adapter = createLocalStorageAdapter({
        storage,
        quotaWarningThresholdBytes: 5 * 1024 * 1024 + 1,
        onError: (_e, ctx) => errors.push(ctx),
      });

      await adapter.put('queue', { id: '1', status: 'pending' });
      await adapter.put('queue', { id: '2', status: 'pending' });
      await adapter.put('queue', { id: '3', status: 'pending' });

      expect(errors.filter((e) => e.scope === 'quota')).toHaveLength(1);
    });

    it('never warns when quotaWarningThresholdBytes is 0', async () => {
      const storage = createFakeStorage();
      storage.setItem('other-app-data', 'x'.repeat(2_500_000)); // would otherwise trip the warning
      const errors: Array<{ scope: string }> = [];
      const adapter = createLocalStorageAdapter({
        storage,
        quotaWarningThresholdBytes: 0,
        onError: (_e, ctx) => errors.push(ctx),
      });

      await adapter.put('queue', { id: '1', status: 'pending' });

      expect(errors).toHaveLength(0);
    });

    it('never warns without an onError handler to report to', async () => {
      const storage = createFakeStorage();
      storage.setItem('other-app-data', 'x'.repeat(2_500_000)); // would otherwise trip the warning
      const adapter = createLocalStorageAdapter({ storage });

      // No onError configured — put() must not throw just because it has nowhere to report to.
      await expect(adapter.put('queue', { id: '1', status: 'pending' })).resolves.toBeUndefined();
    });
  });
});
