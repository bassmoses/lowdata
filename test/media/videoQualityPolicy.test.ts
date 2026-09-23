import { describe, expect, it } from 'vitest';
import { pickInitialSourceIndex } from '../../src/media/videoQualityPolicy.js';
import type { VideoSource } from '../../src/media/resilientVideo.js';

describe('pickInitialSourceIndex', () => {
  it('returns -1 when offline, regardless of sources', () => {
    const sources: VideoSource[] = [{ src: '/a.mp4' }];
    expect(pickInitialSourceIndex(sources, 'offline')).toBe(-1);
  });

  it('returns -1 when sources is empty, for any non-offline quality', () => {
    expect(pickInitialSourceIndex([], 'online')).toBe(-1);
    expect(pickInitialSourceIndex([], 'slow')).toBe(-1);
  });

  it('prefers a source tagged for the current quality tier', () => {
    const sources: VideoSource[] = [
      { src: '/hi.mp4', quality: 'online' },
      { src: '/lo.mp4', quality: 'slow' },
    ];
    expect(pickInitialSourceIndex(sources, 'online')).toBe(0);
    expect(pickInitialSourceIndex(sources, 'slow')).toBe(1);
  });

  it('falls back to the first untagged ("any tier") source when nothing matches the tier', () => {
    const sources: VideoSource[] = [{ src: '/hi.mp4', quality: 'online' }, { src: '/any.mp4' }];
    expect(pickInitialSourceIndex(sources, 'slow')).toBe(1);
  });

  it('falls back to index 0 when nothing matches the tier and nothing is untagged', () => {
    const sources: VideoSource[] = [{ src: '/hi.mp4', quality: 'online' }];
    expect(pickInitialSourceIndex(sources, 'slow')).toBe(0);
  });
});
