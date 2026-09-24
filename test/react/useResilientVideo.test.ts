import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useResilientVideo } from '../../src/react/useResilientVideo.js';
import type { VideoSource } from '../../src/media/resilientVideo.js';

const SOURCE_A: VideoSource = { src: '/a.mp4' };
const SOURCES: VideoSource[] = [SOURCE_A, { src: '/b.mp4' }];
// A stable array reference — `useResilientVideo`'s `useMemo` depends on `sources` by identity, so
// passing a fresh inline array literal to `renderHook`'s callback would recreate the loader on
// every re-render the loader's own state change induces, in an unbounded loop.
const SOURCE_A_ONLY: VideoSource[] = [SOURCE_A];

describe('useResilientVideo (react)', () => {
  it('arms the first source immediately, and reportPlayable() flows through to state', () => {
    const { result, unmount } = renderHook(() => useResilientVideo({ sources: SOURCES }));
    expect(result.current.state.status).toBe('loading');
    expect(result.current.state.videoSrc).toBe('/a.mp4');

    act(() => {
      result.current.reportPlayable();
    });
    expect(result.current.state.status).toBe('playable');
    unmount();
  });

  it('reportError() and retry() flow through to state', () => {
    // retry() re-arms a fresh stall timer — unmount so it (and the loader's connection-monitor
    // subscription) don't dangle past this test.
    const { result, unmount } = renderHook(() => useResilientVideo({ sources: SOURCE_A_ONLY }));

    act(() => {
      result.current.reportError('error');
    });
    expect(result.current.state.status).toBe('exhausted');

    act(() => {
      result.current.retry();
    });
    expect(result.current.state.status).toBe('loading');
    unmount();
  });

  it('destroys the underlying loader on unmount without throwing', () => {
    const { unmount } = renderHook(() => useResilientVideo({ sources: SOURCES }));
    expect(() => unmount()).not.toThrow();
  });
});
