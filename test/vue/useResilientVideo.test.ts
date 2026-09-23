import { effectScope } from 'vue';
import { describe, expect, it } from 'vitest';
import { useResilientVideo } from '../../src/vue/useResilientVideo.js';
import type { VideoSource } from '../../src/media/resilientVideo.js';

const SOURCE_A: VideoSource = { src: '/a.mp4' };
const SOURCES: VideoSource[] = [SOURCE_A, { src: '/b.mp4' }];

describe('useResilientVideo (vue)', () => {
  it('arms the first source immediately, and reportPlayable() flows through to state', () => {
    const scope = effectScope();
    const video = scope.run(() => useResilientVideo({ sources: SOURCES }))!;
    expect(video.state.value.status).toBe('loading');
    expect(video.state.value.videoSrc).toBe('/a.mp4');

    video.reportPlayable();
    expect(video.state.value.status).toBe('playable');

    scope.stop();
  });

  it('reportError() and retry() flow through to state', () => {
    const scope = effectScope();
    const video = scope.run(() => useResilientVideo({ sources: [SOURCE_A] }))!;

    video.reportError('error');
    expect(video.state.value.status).toBe('exhausted');

    video.retry();
    expect(video.state.value.status).toBe('loading');

    scope.stop();
  });

  it('destroys the underlying loader when the scope stops, without throwing', () => {
    const scope = effectScope();
    scope.run(() => useResilientVideo({ sources: SOURCES }));
    expect(() => scope.stop()).not.toThrow();
  });
});
