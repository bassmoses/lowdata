import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressiveImage } from '../../src/solid/createProgressiveImage.js';
import { waitForCondition } from '../helpers/wait.js';

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

describe('createProgressiveImage (solid)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts with the placeholder, then swaps to the full image once loaded', async () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    let dispose!: () => void;
    const state = createRoot((d) => {
      dispose = d;
      return createProgressiveImage({ src: '/full.jpg', placeholder: '/tiny.jpg' });
    });
    expect(state()).toEqual({ src: '/tiny.jpg', isLoaded: false });

    await waitForCondition(() => state().isLoaded, {
      message: 'expected the loader to swap to the full image',
    });
    expect(state()).toEqual({ src: '/full.jpg', isLoaded: true });

    dispose();
  });

  it('destroys the underlying loader when the root is disposed, without throwing', () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      return createProgressiveImage({ src: '/full.jpg', placeholder: '/tiny.jpg' });
    });

    expect(() => dispose()).not.toThrow();
  });
});
