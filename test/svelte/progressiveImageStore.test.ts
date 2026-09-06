import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressiveImageStore } from '../../src/svelte/progressiveImageStore.js';
import { FakeImage } from '../helpers/fakeImage.js';
import { waitForCondition } from '../helpers/wait.js';

describe('createProgressiveImageStore (svelte)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts with the placeholder, then swaps to the full image once loaded', async () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const store = createProgressiveImageStore({ src: '/full.jpg', placeholder: '/tiny.jpg' });
    let latest: { src: string; isLoaded: boolean } | undefined;
    const unsubscribe = store.subscribe((state) => {
      latest = state;
    });
    expect(latest).toEqual({ src: '/tiny.jpg', isLoaded: false });

    await waitForCondition(() => latest?.isLoaded === true, {
      message: 'expected the loader to swap to the full image',
    });
    expect(latest).toEqual({ src: '/full.jpg', isLoaded: true });

    unsubscribe();
    store.destroy();
  });
});
