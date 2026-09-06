import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineFormStore } from '../../src/svelte/offlineFormStore.js';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';

describe('createOfflineFormStore (svelte)', () => {
  let client: LowdataClient | undefined;

  afterEach(() => {
    client?.destroy();
    client = undefined;
    vi.unstubAllGlobals();
  });

  it('starts idle, then reflects submit() through to success via the store contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    client = createLowdataClient({ namespace: `svelte-form-test-${Math.random()}` });
    const form = createOfflineFormStore<{ name: string }>({
      id: 'clinic-intake',
      endpoint: '/api/patients',
      client,
    });

    const statuses: string[] = [];
    const unsubscribe = form.subscribe((status) => statuses.push(status));
    expect(statuses).toEqual(['idle']); // supplied synchronously on subscribe

    await form.submit({ name: 'Amina' });

    expect(statuses[statuses.length - 1]).toBe('success');
    unsubscribe();
    form.destroy();
  });
});
