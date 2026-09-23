import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineForm } from '../../src/forms/offlineForm.js';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';
import { setOnline } from '../helpers/dom.js';
import { resetSharedDb } from '../helpers/db.js';
import { waitForCondition } from '../helpers/wait.js';

// Each client — and therefore its form drafts too, now that they're routed through the client's
// own storage adapter rather than one hardcoded shared database — lives in its own namespace per
// test (see test/network/client.test.ts for why). `resetSharedDb()` is still used for the handful
// of tests below that deliberately share the *default* client (no namespace given).
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

  it('two clients in different namespaces never share drafts for the same form id (multi-tenant isolation)', async () => {
    const suffix = Math.random();
    const tenantA = createLowdataClient({ namespace: `tenant-a-${suffix}` });
    const tenantB = createLowdataClient({ namespace: `tenant-b-${suffix}` });
    try {
      const formA = createOfflineForm<{ name: string }>({
        id: 'clinic-intake',
        endpoint: '/api/patients',
        client: tenantA,
      });
      await formA.save({ name: "Tenant A's patient" });

      // A fresh form for the *same* id, under tenant B's client, must not recover tenant A's draft.
      const formB = createOfflineForm<{ name: string }>({
        id: 'clinic-intake',
        endpoint: '/api/patients',
        client: tenantB,
      });
      // Give any (incorrect) cross-tenant recovery a chance to happen before asserting it didn't.
      await new Promise((r) => setTimeout(r, 20));
      expect(formB.getStatus()).toBe('idle');

      formA.destroy();
      formB.destroy();
    } finally {
      tenantA.destroy();
      tenantB.destroy();
    }
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

  it('uses a shared lazily-created default client when config.client is omitted, so drafts persist across instances', async () => {
    // No `client` in config — exercises `getDefaultClient()`'s lazy-create-then-memoize path.
    // Reusing the same form id across two default-client instances (rather than just asserting no
    // throw) proves the *same* underlying client/storage is reused, not a fresh one per form.
    const form1 = createOfflineForm<{ name: string }>({
      id: 'clinic-intake-default',
      endpoint: '/api/patients',
    });
    await form1.save({ name: 'Amina' });
    expect(form1.getStatus()).toBe('saved');

    const form2 = createOfflineForm<{ name: string }>({
      id: 'clinic-intake-default',
      endpoint: '/api/patients',
    });
    await waitForCondition(() => form2.getStatus() === 'saved', {
      message: `expected recovered draft status 'saved', got '${form2.getStatus()}'`,
    });

    await form1.discard();
    form1.destroy();
    form2.destroy();
  });

  it('a queued item failing with a retryable status stays "pending" (with the transient error attached) and still reaches success once the retry lands', async () => {
    client = createLowdataClient({
      namespace: uniqueNamespace(),
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitter: 'none' },
    });
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        // 503 is in the retryable status set — the first sync attempt should fail but retry,
        // not settle the form as 'failed'.
        return new Response(null, { status: callCount === 1 ? 503 : 200 });
      }),
    );

    const events: Array<{ status: string; error?: string }> = [];
    form.subscribe((status, detail) => events.push({ status, error: detail?.error }));

    const result = await form.submit({ name: 'Amina' });
    expect(result.status).toBe('pending');

    setOnline(true);
    window.dispatchEvent(new Event('online'));

    await waitForCondition(() => form.getStatus() === 'success', {
      message: `expected form to reach 'success', last status was '${form.getStatus()}'`,
    });
    // This 'pending'-with-error is the item-failed/willRetry:true branch specifically — distinct
    // from the plain 'pending' emitted the moment the form was first queued (no error attached).
    expect(events).toContainEqual(
      expect.objectContaining({ status: 'pending', error: expect.any(String) }),
    );
  });

  it('a queued item failing with a non-retryable status reaches "failed" via the background sync path, not just the live-fetch path', async () => {
    client = createLowdataClient({
      namespace: uniqueNamespace(),
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitter: 'none' },
    });
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    const result = await form.submit({ name: 'Amina' });
    expect(result.status).toBe('pending');

    // 500 is not in the retryable status set, so this should fail on the very first sync attempt
    // regardless of maxRetries.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    setOnline(true);
    window.dispatchEvent(new Event('online'));

    await waitForCondition(() => form.getStatus() === 'failed', {
      message: `expected form to reach 'failed', last status was '${form.getStatus()}'`,
    });
  });
});
