import { describe, expect, it } from 'vitest';
import { createResilientVideoStore } from '../../src/svelte/resilientVideoStore.js';
import type { VideoSource } from '../../src/media/resilientVideo.js';
import type { ResilientVideoState } from '../../src/media/resilientVideo.js';

const SOURCES: VideoSource[] = [{ src: '/a.mp4' }, { src: '/b.mp4' }];

describe('createResilientVideoStore (svelte)', () => {
  it('arms the first source immediately, and reportPlayable() flows through to the store', () => {
    const store = createResilientVideoStore({ sources: SOURCES });
    let latest: ResilientVideoState | undefined;
    const unsubscribe = store.subscribe((state) => {
      latest = state;
    });
    expect(latest?.status).toBe('loading');
    expect(latest?.videoSrc).toBe('/a.mp4');

    store.reportPlayable();
    expect(latest?.status).toBe('playable');

    unsubscribe();
    store.destroy();
  });
});
