import { afterEach, describe, expect, it, vi } from 'vitest';
import { offlineFormStatus$ } from '../../src/angular/offlineFormStatus.js';
import { createOfflineForm } from '../../src/forms/offlineForm.js';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';

describe('offlineFormStatus$ (angular/rxjs)', () => {
  let client: LowdataClient | undefined;

  afterEach(() => {
    client?.destroy();
    client = undefined;
    vi.unstubAllGlobals();
  });

  it('emits idle immediately, then success once submit() resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    client = createLowdataClient({ namespace: `angular-form-test-${Math.random()}` });
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    const statuses: string[] = [];
    const subscription = offlineFormStatus$(form).subscribe((status) => statuses.push(status));
    expect(statuses).toEqual(['idle']);

    await form.submit({ name: 'Amina' });

    expect(statuses[statuses.length - 1]).toBe('success');
    subscription.unsubscribe();
    form.destroy();
  });

  it('wires save(), the submit() failure path, and retry() through to success — not just the happy path', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        // First attempt fails with a non-retryable status; retry() should be able to recover it.
        return new Response(null, { status: callCount === 1 ? 400 : 200 });
      }),
    );
    client = createLowdataClient({ namespace: `angular-form-test-${Math.random()}` });
    const form = createOfflineForm<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    const statuses: string[] = [];
    const subscription = offlineFormStatus$(form).subscribe((status) => statuses.push(status));

    await form.save({ name: 'Amina (draft)' });
    expect(statuses[statuses.length - 1]).toBe('saved');

    await form.submit({ name: 'Amina' });
    expect(statuses[statuses.length - 1]).toBe('failed');

    await form.retry();
    expect(statuses[statuses.length - 1]).toBe('success');
    expect(callCount).toBe(2);

    subscription.unsubscribe();
    form.destroy();
  });
});
