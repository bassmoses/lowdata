import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useResilientVideo } from '../../src/react/useResilientVideo.js';
import type { VideoSource } from '../../src/media/resilientVideo.js';

const SOURCES: VideoSource[] = [{ src: '/a.mp4' }, { src: '/b.mp4' }];

describe('useResilientVideo (react)', () => {
  it('arms the first source immediately, and reportPlayable() flows through to state', () => {
    const { result } = renderHook(() => useResilientVideo({ sources: SOURCES }));
    expect(result.current.state.status).toBe('loading');
    expect(result.current.state.videoSrc).toBe('/a.mp4');

    act(() => {
      result.current.reportPlayable();
    });
    expect(result.current.state.status).toBe('playable');
  });

  it('destroys the underlying loader on unmount without throwing', () => {
    const { unmount } = renderHook(() => useResilientVideo({ sources: SOURCES }));
    expect(() => unmount()).not.toThrow();
  });
});
