import { effectScope } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useLowdataClient } from '../../src/vue/useLowdataClient.js';

describe('useLowdataClient (vue)', () => {
  it('creates a working LowdataClient', () => {
    const scope = effectScope();
    const client = scope.run(() =>
      useLowdataClient({ namespace: `vue-client-test-${Math.random()}` }),
    )!;

    expect(typeof client.fetch).toBe('function');
    expect(client.connection.getStatus().quality).toBe('online');
    scope.stop();
  });

  it('destroys the client when the scope stops', () => {
    const scope = effectScope();
    const client = scope.run(() =>
      useLowdataClient({ namespace: `vue-client-test-destroy-${Math.random()}` }),
    )!;
    const destroySpy = vi.spyOn(client, 'destroy');

    scope.stop();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});
