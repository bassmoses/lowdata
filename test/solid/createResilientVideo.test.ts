import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createResilientVideo } from '../../src/solid/createResilientVideo.js';
import type { VideoSource } from '../../src/media/resilientVideo.js';

const SOURCES: VideoSource[] = [{ src: '/a.mp4' }, { src: '/b.mp4' }];

describe('createResilientVideo (solid)', () => {
  it('arms the first source immediately, and reportPlayable() flows through to the signal', () => {
    let dispose!: () => void;
    const video = createRoot((d) => {
      dispose = d;
      return createResilientVideo({ sources: SOURCES });
    });
    expect(video.state().status).toBe('loading');
    expect(video.state().videoSrc).toBe('/a.mp4');

    video.reportPlayable();
    expect(video.state().status).toBe('playable');

    dispose();
  });

  it('destroys the underlying loader when the root is disposed, without throwing', () => {
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      return createResilientVideo({ sources: SOURCES });
    });
    expect(() => dispose()).not.toThrow();
  });
});
