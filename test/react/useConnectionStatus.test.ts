import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useConnectionStatus } from '../../src/react/useConnectionStatus.js';
import { setOnline } from '../helpers/dom.js';

describe('useConnectionStatus', () => {
  it('reflects the current connection quality and updates when it changes', () => {
    setOnline(true);
    const { result } = renderHook(() => useConnectionStatus());
    expect(result.current.quality).toBe('online');

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current.quality).toBe('offline');

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current.quality).toBe('online');
  });
});
