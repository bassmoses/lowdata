import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProgressiveImage } from '../../src/react/useProgressiveImage.js';

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = '';

  set src(value: string) {
    this._src = value;
    queueMicrotask(() => this.onload?.());
  }

  get src(): string {
    return this._src;
  }
}

describe('useProgressiveImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts with the placeholder, then swaps to the full image once loaded', async () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const { result } = renderHook(() =>
      useProgressiveImage({ src: '/full.jpg', placeholder: '/tiny.jpg' }),
    );
    expect(result.current).toEqual({ src: '/tiny.jpg', isLoaded: false });

    await waitFor(() => expect(result.current).toEqual({ src: '/full.jpg', isLoaded: true }));
  });

  it('destroys the underlying loader on unmount without throwing', () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const { unmount } = renderHook(() =>
      useProgressiveImage({ src: '/full.jpg', placeholder: '/tiny.jpg' }),
    );

    expect(() => unmount()).not.toThrow();
  });
});
