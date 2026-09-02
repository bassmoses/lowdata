import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLowdataClient } from '../../src/react/useLowdataClient.js';
import { resetSharedDb } from '../helpers/db.js';

describe('useLowdataClient', () => {
  beforeEach(async () => {
    await resetSharedDb();
  });

  afterEach(async () => {
    await resetSharedDb();
  });

  it('creates a LowdataClient and exposes its API', () => {
    const { result } = renderHook(() => useLowdataClient());
    expect(typeof result.current.fetch).toBe('function');
    expect(typeof result.current.onSync).toBe('function');
    expect(result.current.connection.getStatus().quality).toBe('online');
    result.current.destroy();
  });

  it('destroys the client on unmount', () => {
    const { result, unmount } = renderHook(() => useLowdataClient());
    const destroySpy = vi.spyOn(result.current, 'destroy');

    unmount();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('reads config only on first render — later renders keep the same client instance', () => {
    const { result, rerender } = renderHook(
      (props: { baseUrl?: string }) => useLowdataClient(props),
      { initialProps: { baseUrl: '/a' } },
    );
    const first = result.current;

    rerender({ baseUrl: '/b' });

    expect(result.current).toBe(first);
    first.destroy();
  });
});
