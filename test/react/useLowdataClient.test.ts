import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useLowdataClient } from '../../src/react/useLowdataClient.js';

// Each test uses its own IndexedDB namespace so tests never contend on the same physical database
// connection — see test/network/client.test.ts for the same reasoning.
function uniqueNamespace(): string {
  return `use-lowdata-client-test-${Math.random()}`;
}

describe('useLowdataClient', () => {
  it('creates a LowdataClient and exposes its API', () => {
    const { result } = renderHook(() => useLowdataClient({ namespace: uniqueNamespace() }));
    expect(typeof result.current.fetch).toBe('function');
    expect(typeof result.current.onSync).toBe('function');
    expect(result.current.connection.getStatus().quality).toBe('online');
    result.current.destroy();
  });

  it('destroys the client on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useLowdataClient({ namespace: uniqueNamespace() }),
    );
    const destroySpy = vi.spyOn(result.current, 'destroy');

    unmount();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('reads config only on first render — later renders keep the same client instance', () => {
    const namespace = uniqueNamespace();
    const { result, rerender } = renderHook(
      (props: { baseUrl?: string }) => useLowdataClient({ ...props, namespace }),
      { initialProps: { baseUrl: '/a' } },
    );
    const first = result.current;

    rerender({ baseUrl: '/b' });

    expect(result.current).toBe(first);
    first.destroy();
  });
});
