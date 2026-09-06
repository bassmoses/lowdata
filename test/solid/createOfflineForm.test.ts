import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineForm } from '../../src/solid/createOfflineForm.js';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';

describe('createOfflineForm (solid)', () => {
  let client: LowdataClient | undefined;

  afterEach(() => {
    client?.destroy();
    client = undefined;
    vi.unstubAllGlobals();
  });

  it('starts idle, then reflects submit() through to success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    client = createLowdataClient({ namespace: `solid-form-test-${Math.random()}` });

    let dispose!: () => void;
    const form = createRoot((d) => {
      dispose = d;
      return createOfflineForm<{ name: string }>({
        id: 'clinic-intake',
        endpoint: '/api/patients',
        client,
      });
    });
    expect(form.status()).toBe('idle');

    await form.submit({ name: 'Amina' });

    expect(form.status()).toBe('success');
    dispose();
  });
});
