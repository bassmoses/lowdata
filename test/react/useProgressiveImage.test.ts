import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProgressiveImage } from '../../src/react/useProgressiveImage.js';
import { FakeImage } from '../helpers/fakeImage.js';

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
