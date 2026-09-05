import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineForm } from '../../src/forms/offlineForm.js';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';
import { setOnline } from '../helpers/dom.js';
import { resetSharedDb } from '../helpers/db.js';
import { waitForCondition } from '../helpers/wait.js';

// The client's own queue lives in its own namespace per test (see test/network/client.test.ts for
// why) — independent of `resetSharedDb()`, which resets the *form drafts* store that
// `createOfflineForm` always shares via lowdata's default database regardless of client namespace.
function uniqueNamespace(): string {
  return `offline-form-test-${Math.random()}`;
}

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
    client = createLowdataClient({ namespace: uniqueNamespace() });
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
    await waitForCondition(() => form2.getStatus() === 'saved', {
      message: `expected recovered draft status 'saved', got '${form2.getStatus()}'`,
    });
  });

  it('submit() resolves "success" immediately when online and the endpoint responds ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    client = createLowdataClient({ namespace: uniqueNamespace() });
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
    client = createLowdataClient({ namespace: uniqueNamespace() });
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    const result = await form.submit({ name: 'Amina' });
    expect(result.status).toBe('failed');
  });

  it('submit() while offline queues, then auto-syncs to success once back online', async () => {
    client = createLowdataClient({ namespace: uniqueNamespace() });
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

    await waitForCondition(() => form.getStatus() === 'success', {
      message: `expected form to reach 'success', last status was '${form.getStatus()}'`,
    });
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
    client = createLowdataClient({ namespace: uniqueNamespace() });
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    const first = form.submit({ name: 'Amina' }); // S1 — in flight, will resolve late
    await waitForCondition(() => callCount >= 1, { message: "expected S1's fetch() to be called" });
    const second = form.submit({ name: 'Amina (corrected)' }); // S2 — supersedes S1
    await waitForCondition(() => callCount >= 2, { message: "expected S2's fetch() to be called" });

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
    await waitForCondition(() => recovered.getStatus() === 'saved', {
      message: `expected recovered draft status 'saved', got '${recovered.getStatus()}'`,
    });
    recovered.destroy();

    resolvers[2]?.();
    await second;
  });

  it('destroy() unsubscribes from sync events, so status stops updating after it', async () => {
    client = createLowdataClient({ namespace: uniqueNamespace() });
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

    let synced = false;
    client.onSync((e) => {
      if (e.type === 'item-success') synced = true;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    setOnline(true);
    window.dispatchEvent(new Event('online'));

    // Wait for the underlying queued request to actually sync (confirms this isn't passing merely
    // because it didn't have time to happen yet), then assert the form — whose subscription was
    // destroyed — never observed it.
    await waitForCondition(() => synced, {
      message: 'expected the queued request to sync in the background',
    });
    expect(statuses).toEqual([]);
    expect(form.getStatus()).toBe('pending');
  });

  it('retry() resubmits the last values', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    client = createLowdataClient({ namespace: uniqueNamespace() });
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
    client = createLowdataClient({ namespace: uniqueNamespace() });
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
