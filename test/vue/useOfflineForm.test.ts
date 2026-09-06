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
});
