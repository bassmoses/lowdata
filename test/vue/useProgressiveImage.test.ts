import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProgressiveImage } from '../../src/vue/useProgressiveImage.js';
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

describe('useProgressiveImage (vue)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts with the placeholder, then swaps to the full image once loaded', async () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const scope = effectScope();
    const state = scope.run(() =>
      useProgressiveImage({ src: '/full.jpg', placeholder: '/tiny.jpg' }),
    )!;
    expect(state.value).toEqual({ src: '/tiny.jpg', isLoaded: false });

    await waitForCondition(() => state.value.isLoaded, {
      message: 'expected the loader to swap to the full image',
    });
    expect(state.value).toEqual({ src: '/full.jpg', isLoaded: true });

    scope.stop();
  });

  it('destroys the underlying loader when the scope stops, without throwing', () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const scope = effectScope();
    scope.run(() => useProgressiveImage({ src: '/full.jpg', placeholder: '/tiny.jpg' }));

    expect(() => scope.stop()).not.toThrow();
  });
});
