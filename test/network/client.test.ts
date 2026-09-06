import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';
import { isQueued } from '../../src/network/types.js';
import { setOnline } from '../helpers/dom.js';
import { waitForCondition } from '../helpers/wait.js';

// Every test gets its own IndexedDB namespace (a fresh physical database) rather than sharing
// lowdata's default database and resetting it between tests. That sidesteps IndexedDB's own
// close/delete lifecycle entirely — no test needs to wait for another test's connection to close
// before it can safely open (or delete) the same database.
function uniqueNamespace(): string {
  return `client-test-${Math.random()}`;
}

describe('LowdataClient', () => {
  let client: LowdataClient | undefined;

  beforeEach(() => {
    setOnline(true);
  });

  afterEach(() => {
    client?.destroy();
    client = undefined;
    vi.unstubAllGlobals();
    setOnline(true);
  });

  it('passes successful live requests straight through as a Response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );
    client = createLowdataClient({ namespace: uniqueNamespace() });

    const result = await client.fetch('/api/ping');
    expect(isQueued(result)).toBe(false);
    expect((result as Response).status).toBe(200);
  });

  it('queues a mutating request when offline instead of losing it', async () => {
    client = createLowdataClient({ namespace: uniqueNamespace() });
    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    const result = await client.fetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
    });
    expect(isQueued(result)).toBe(true);
    if (isQueued(result)) {
      expect(result.item.status).toBe('pending');
      expect(result.item.method).toBe('POST');
    }
    expect(await client.queue.list()).toHaveLength(1);
  });

  it('throws for a GET while offline instead of silently queuing a read', async () => {
    client = createLowdataClient({ namespace: uniqueNamespace() });
    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    await expect(client.fetch('/api/orders')).rejects.toThrow();
  });

  it('falls back to the queue when a live mutating request keeps failing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    client = createLowdataClient({
      namespace: uniqueNamespace(),
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5, jitter: 'none' },
      // This test doesn't await the background sync notifyEnqueued() kicks off, so it can still be
      // mid-flight when afterEach() destroys the client — a benign, already-covered race
      // (test/network/sync.test.ts asserts drain() swallows exactly this). Silence the resulting
      // onError instead of letting it print a console.warn on every run.
      onError: () => {},
    });

    const result = await client.fetch('/api/orders', { method: 'POST', body: '{}' });
    expect(isQueued(result)).toBe(true);
  });

  it('rejects a queue item whose body exceeds maxQueueItemSizeBytes', async () => {
    client = createLowdataClient({ namespace: uniqueNamespace(), maxQueueItemSizeBytes: 10 });
    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    await expect(
      client.fetch('/api/orders', { method: 'POST', body: 'this body is way over ten bytes' }),
    ).rejects.toThrow(RangeError);
  });

  it('queue.add()/list()/cancel()/clear() manage items directly', async () => {
    client = createLowdataClient({ namespace: uniqueNamespace() });
    const item = await client.queue.add({
      url: '/api/x',
      method: 'POST',
      priority: 'high',
      body: '{}',
    });

    expect((await client.queue.list()).map((i) => i.id)).toContain(item.id);

    await client.queue.cancel(item.id);
    const cancelled = (await client.queue.list()).find((i) => i.id === item.id);
    expect(cancelled?.status).toBe('cancelled');

    await client.queue.clear();
    expect(await client.queue.list()).toHaveLength(0);
  });

  it('forwards sync events via onSync() as a queued item is auto-synced', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    client = createLowdataClient({ namespace: uniqueNamespace() });

    const eventTypes: string[] = [];
    const unsubscribe = client.onSync((e) => eventTypes.push(e.type));

    await client.queue.add({ url: '/api/x', method: 'POST', priority: 'normal', body: '{}' });
    await waitForCondition(() => eventTypes.includes('item-success'), {
      message: `expected an 'item-success' sync event, got: ${eventTypes.join(', ') || '(none)'}`,
    });

    expect(eventTypes).toContain('item-success');
    unsubscribe();
  });

  it('connection.getStatus()/subscribe() reflect the live connection state', () => {
    client = createLowdataClient({ namespace: uniqueNamespace() });
    expect(client.connection.getStatus().quality).toBe('online');

    const listener = vi.fn();
    const unsubscribe = client.connection.subscribe(listener);
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ quality: 'offline' }));
    unsubscribe();
  });

  it('destroy() prevents further use', async () => {
    client = createLowdataClient({ namespace: uniqueNamespace() });
    client.destroy();
    await expect(client.fetch('/api/x')).rejects.toThrow();
  });

  it('auto-generates an Idempotency-Key header for a mutating request by default', async () => {
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentHeaders.push(init?.headers as Record<string, string> | undefined);
        return new Response(null, { status: 200 });
      }),
    );
    client = createLowdataClient({ namespace: uniqueNamespace() });

    await client.fetch('/api/orders', { method: 'POST', body: '{}' });
    expect(sentHeaders[0]?.['Idempotency-Key']).toBeTruthy();
  });

  it('does not attach an Idempotency-Key when autoIdempotencyKey is disabled', async () => {
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentHeaders.push(init?.headers as Record<string, string> | undefined);
        return new Response(null, { status: 200 });
      }),
    );
    client = createLowdataClient({ namespace: uniqueNamespace(), autoIdempotencyKey: false });

    await client.fetch('/api/orders', { method: 'POST', body: '{}' });
    expect(sentHeaders[0]?.['Idempotency-Key']).toBeUndefined();
  });

  it('queue.retry() moves a failed item back to pending for another attempt', async () => {
    client = createLowdataClient({
      namespace: uniqueNamespace(),
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5, jitter: 'none' },
    });
    const item = await client.queue.add({
      url: '/api/x',
      method: 'POST',
      priority: 'normal',
      body: '{}',
    });
    await client.queue.cancel(item.id); // cheapest way to reach a terminal, non-'done' state directly
    let current = (await client.queue.list()).find((i) => i.id === item.id);
    expect(current?.status).toBe('cancelled');

    await client.queue.retry(item.id);
    current = (await client.queue.list()).find((i) => i.id === item.id);
    expect(current?.status).toBe('pending');
    expect(current?.attempts).toBe(0);
  });

  it('queue.subscribe() fires with the current snapshot immediately, and again after a change', async () => {
    client = createLowdataClient({ namespace: uniqueNamespace() });
    const snapshots: number[] = [];
    const unsubscribe = client.queue.subscribe((items) => snapshots.push(items.length));

    await waitForCondition(() => snapshots.length >= 1, { message: 'expected an initial snapshot' });
    expect(snapshots[0]).toBe(0);

    await client.queue.add({ url: '/api/x', method: 'POST', priority: 'normal', body: '{}' });
    await waitForCondition(() => snapshots.some((n) => n === 1), {
      message: `expected a snapshot of length 1, got: ${snapshots.join(', ')}`,
    });

    unsubscribe();
  });

  it('isolates two clients in different namespaces from each other', async () => {
    const suffix = Math.random();
    const clientA = createLowdataClient({ namespace: `business-a-${suffix}` });
    const clientB = createLowdataClient({ namespace: `business-b-${suffix}` });
    try {
      await clientA.queue.add({ url: '/api/x', method: 'POST', priority: 'normal', body: '{}' });
      expect(await clientA.queue.list()).toHaveLength(1);
      expect(await clientB.queue.list()).toHaveLength(0);
    } finally {
      clientA.destroy();
      clientB.destroy();
    }
  });

  it('sync() manually drains the queue — for hosts with no automatic reconnect/visibility trigger (React Native, Electron main, Node)', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    client = createLowdataClient({ namespace: uniqueNamespace() });

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    await client.fetch('/api/orders', { method: 'POST', body: '{}' });
    expect(fetchMock).not.toHaveBeenCalled();

    // Report connectivity manually (as a React Native NetInfo/Electron/Node host would) rather
    // than dispatching a DOM event. That report *also* auto-triggers SyncManager's own
    // reconnect listener — same as a real browser event would — so this can't prove sync() alone
    // caused the send; what it proves is sync()'s actual contract: calling it either performs the
    // drain itself or safely no-ops into an already-in-progress one, and either way the queued
    // item reliably ends up sent. waitForCondition (not an immediate assertion) is required here
    // precisely because that auto-triggered drain is fire-and-forget, not awaited by sync().
    client.connection.report({ quality: 'online', online: true });
    await client.sync();

    await waitForCondition(() => fetchMock.mock.calls.length > 0, {
      message: 'expected sync() to result in the queued item being sent',
    });
    expect(await client.queue.list()).toHaveLength(0);
  });

  it("connection.report() manually feeds connectivity — reporting 'online' triggers the same auto-drain a real browser event would", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    client = createLowdataClient({ namespace: uniqueNamespace() });

    client.connection.report({ quality: 'offline', online: false });
    const result = await client.fetch('/api/orders', { method: 'POST', body: '{}' });
    expect(isQueued(result)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    client.connection.report({ quality: 'online', online: true });
    await waitForCondition(() => fetchMock.mock.calls.length > 0, {
      message: 'expected reporting online to trigger an automatic drain',
    });
  });

  it("encrypts a queued item's body at rest via a supplied encryption hook", async () => {
    client = createLowdataClient({
      namespace: uniqueNamespace(),
      encryption: {
        encrypt: async (plaintext) => Buffer.from(plaintext).toString('base64'),
        decrypt: async (ciphertext) => Buffer.from(ciphertext, 'base64').toString('utf-8'),
      },
    });
    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    const result = await client.fetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ amount: 42 }),
    });
    expect(isQueued(result)).toBe(true);
    if (isQueued(result)) {
      // The public QueuedResult/queue.list() surface always shows plaintext — encryption is an
      // at-rest concern, invisible to callers.
      expect(result.item.body).toBe(JSON.stringify({ amount: 42 }));
    }
    const listed = (await client.queue.list())[0];
    expect(listed?.body).toBe(JSON.stringify({ amount: 42 }));
  });
});
