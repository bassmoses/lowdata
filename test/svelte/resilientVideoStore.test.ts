import { describe, expect, it } from 'vitest';
import { createResilientVideoStore } from '../../src/svelte/resilientVideoStore.js';
import type { VideoSource } from '../../src/media/resilientVideo.js';
import type { ResilientVideoState } from '../../src/media/resilientVideo.js';

const SOURCE_A: VideoSource = { src: '/a.mp4' };
const SOURCES: VideoSource[] = [SOURCE_A, { src: '/b.mp4' }];

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

  it('reportError() and retry() flow through to the store', () => {
    const store = createResilientVideoStore({ sources: [SOURCE_A] });
    let latest: ResilientVideoState | undefined;
    const unsubscribe = store.subscribe((state) => {
      latest = state;
    });

    store.reportError('error');
    expect(latest?.status).toBe('exhausted');

    store.retry();
    expect(latest?.status).toBe('loading');

    unsubscribe();
    store.destroy();
  });
});
