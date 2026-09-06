import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { createLowdataClient } from '../../src/solid/createLowdataClient.js';

describe('createLowdataClient (solid)', () => {
  it('creates a working LowdataClient', () => {
    let dispose!: () => void;
    const client = createRoot((d) => {
      dispose = d;
      return createLowdataClient({ namespace: `solid-client-test-${Math.random()}` });
    });

    expect(typeof client.fetch).toBe('function');
    expect(client.connection.getStatus().quality).toBe('online');
    dispose();
  });

  it('destroys the client when the root is disposed', () => {
    let dispose!: () => void;
    const client = createRoot((d) => {
      dispose = d;
      return createLowdataClient({ namespace: `solid-client-test-destroy-${Math.random()}` });
    });
    const destroySpy = vi.spyOn(client, 'destroy');

    dispose();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});
