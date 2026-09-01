import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';
import { isQueued } from '../../src/network/types.js';
import { setOnline } from '../helpers/dom.js';
import { resetSharedDb } from '../helpers/db.js';

describe('LowdataClient', () => {
  let client: LowdataClient | undefined;

  beforeEach(async () => {
    await resetSharedDb();
    setOnline(true);
  });

  afterEach(async () => {
    client?.destroy();
    client = undefined;
    vi.unstubAllGlobals();
    setOnline(true);
    await resetSharedDb();
  });

  it('passes successful live requests straight through as a Response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );
    client = createLowdataClient();

    const result = await client.fetch('/api/ping');
    expect(isQueued(result)).toBe(false);
    expect((result as Response).status).toBe(200);
  });

  it('queues a mutating request when offline instead of losing it', async () => {
    client = createLowdataClient();
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
    client = createLowdataClient();
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
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5, jitter: 'none' },
    });

    const result = await client.fetch('/api/orders', { method: 'POST', body: '{}' });
    expect(isQueued(result)).toBe(true);
  });

  it('rejects a queue item whose body exceeds maxQueueItemSizeBytes', async () => {
    client = createLowdataClient({ maxQueueItemSizeBytes: 10 });
    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    await expect(
      client.fetch('/api/orders', { method: 'POST', body: 'this body is way over ten bytes' }),
    ).rejects.toThrow(RangeError);
  });

  it('queue.add()/list()/cancel()/clear() manage items directly', async () => {
    client = createLowdataClient();
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
    client = createLowdataClient();

    const eventTypes: string[] = [];
    const unsubscribe = client.onSync((e) => eventTypes.push(e.type));

    await client.queue.add({ url: '/api/x', method: 'POST', priority: 'normal', body: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(eventTypes).toContain('item-success');
    unsubscribe();
  });

  it('connection.getStatus()/subscribe() reflect the live connection state', () => {
    client = createLowdataClient();
    expect(client.connection.getStatus().quality).toBe('online');

    const listener = vi.fn();
    const unsubscribe = client.connection.subscribe(listener);
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ quality: 'offline' }));
    unsubscribe();
  });

  it('destroy() prevents further use', async () => {
    client = createLowdataClient();
    client.destroy();
    await expect(client.fetch('/api/x')).rejects.toThrow();
  });
});
