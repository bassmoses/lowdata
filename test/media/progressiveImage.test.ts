import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressiveImageLoader } from '../../src/media/progressiveImage.js';
import type { ProgressiveImageState } from '../../src/media/progressiveImage.js';
import { FakeFailingImage, FakeImage } from '../helpers/fakeImage.js';

describe('createProgressiveImageLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the placeholder immediately, then swaps to the full image once loaded', async () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const loader = createProgressiveImageLoader({ src: '/full.jpg', placeholder: '/tiny.jpg' });
    expect(loader.getState()).toEqual({ src: '/tiny.jpg', isLoaded: false });

    const states: Array<{ src: string; isLoaded: boolean }> = [];
    loader.subscribe((s) => states.push(s));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loader.getState()).toEqual({ src: '/full.jpg', isLoaded: true });
    expect(states).toContainEqual({ src: '/full.jpg', isLoaded: true });

    loader.destroy();
  });

  it('reports error: true (without ever setting isLoaded) when the full image fails to load', async () => {
    vi.stubGlobal('Image', FakeFailingImage as unknown as typeof Image);

    const loader = createProgressiveImageLoader({ src: '/broken.jpg', placeholder: '/tiny.jpg' });
    const states: ProgressiveImageState[] = [];
    loader.subscribe((s) => states.push(s));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loader.getState()).toEqual({ src: '/tiny.jpg', isLoaded: false, error: true });
    expect(states).toContainEqual({ src: '/tiny.jpg', isLoaded: false, error: true });

    loader.destroy();
  });

  it('destroy() stops further emissions', async () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const loader = createProgressiveImageLoader({ src: '/full.jpg', placeholder: '/tiny.jpg' });
    const listener = vi.fn();
    loader.subscribe(listener);
    loader.destroy();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).not.toHaveBeenCalled();
  });
});
