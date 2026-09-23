import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOfflineForm } from '../../src/vue/useOfflineForm.js';
import { createLowdataClient, type LowdataClient } from '../../src/network/client.js';

describe('useOfflineForm (vue)', () => {
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
    client = createLowdataClient({ namespace: `vue-form-test-${Math.random()}` });
    const scope = effectScope();
    const form = scope.run(() =>
      useOfflineForm<{ name: string }>({ id: 'clinic-intake', endpoint: '/api/patients', client }),
    )!;
    expect(form.status.value).toBe('idle');

    await form.submit({ name: 'Amina' });

    expect(form.status.value).toBe('success');
    scope.stop();
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
    client = createLowdataClient({ namespace: `vue-form-test-${Math.random()}` });
    const scope = effectScope();
    const form = scope.run(() =>
      useOfflineForm<{ name: string }>({ id: 'clinic-intake', endpoint: '/api/patients', client }),
    )!;

    await form.save({ name: 'Amina (draft)' });
    expect(form.status.value).toBe('saved');

    await form.submit({ name: 'Amina' });
    expect(form.status.value).toBe('failed');

    await form.retry();
    expect(form.status.value).toBe('success');
    expect(callCount).toBe(2);

    scope.stop();
  });
});
