import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineForm } from '../../src/forms/offlineForm.js';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';
import { setOnline } from '../helpers/dom.js';
import { resetSharedDb } from '../helpers/db.js';

describe('createOfflineForm', () => {
  let client: LowdataClient | undefined;

  beforeEach(async () => {
    await resetSharedDb();
    setOnline(true);
  });

  afterEach(() => {
    client?.destroy();
    client = undefined;
    vi.unstubAllGlobals();
  });

  it('save() persists a draft that a fresh form instance for the same id recovers', async () => {
    client = createLowdataClient();
    const form1 = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });
    await form1.save({ name: 'Amina' });
    expect(form1.getStatus()).toBe('saved');

    const form2 = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(form2.getStatus()).toBe('saved');
  });

  it('submit() resolves "success" immediately when online and the endpoint responds ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    client = createLowdataClient();
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    const result = await form.submit({ name: 'Amina' });
    expect(result.status).toBe('success');
    expect(form.getStatus()).toBe('success');
  });

  it('submit() marks the form "failed" on a non-retryable HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 400 })),
    );
    client = createLowdataClient();
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    const result = await form.submit({ name: 'Amina' });
    expect(result.status).toBe('failed');
  });

  it('submit() while offline queues, then auto-syncs to success once back online', async () => {
    client = createLowdataClient();
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    const statuses: string[] = [];
    form.subscribe((s) => statuses.push(s));

    const result = await form.submit({ name: 'Amina' });
    expect(result.status).toBe('pending');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    setOnline(true);
    window.dispatchEvent(new Event('online'));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(form.getStatus()).toBe('success');
    expect(statuses).toContain('syncing');
  });

  it('a stale/superseded submission succeeding late does not discard the current draft', async () => {
    let callCount = 0;
    const resolvers: Array<(() => void) | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const thisCall = ++callCount;
        await new Promise<void>((resolve) => {
          resolvers[thisCall] = resolve;
        });
        return new Response(null, { status: 200 });
      }),
    );
    client = createLowdataClient();
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    const first = form.submit({ name: 'Amina' }); // S1 — in flight, will resolve late
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = form.submit({ name: 'Amina (corrected)' }); // S2 — supersedes S1
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Let S1 (now stale) succeed while S2 is still in flight.
    resolvers[1]?.();
    await first;

    // A fresh form instance for the same id should still recover S2's not-yet-settled draft — S1's
    // stale success must not have discarded it.
    const recovered = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recovered.getStatus()).toBe('saved');
    recovered.destroy();

    resolvers[2]?.();
    await second;
  });

  it('destroy() unsubscribes from sync events, so status stops updating after it', async () => {
    client = createLowdataClient();
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    await form.submit({ name: 'Amina' }); // queued, status: 'pending'

    const statuses: string[] = [];
    form.subscribe((s) => statuses.push(s));
    form.destroy();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // destroy() unsubscribed before the reconnect-triggered sync — even though the underlying
    // queued request did sync successfully, the form must not have observed it.
    expect(statuses).toEqual([]);
    expect(form.getStatus()).toBe('pending');
  });

  it('retry() resubmits the last values', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    client = createLowdataClient();
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    await form.submit({ name: 'Amina' });
    await form.retry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('discard() clears the draft and resets status to idle', async () => {
    client = createLowdataClient();
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });
    await form.save({ name: 'Amina' });
    await form.discard();
    expect(form.getStatus()).toBe('idle');
  });
});
