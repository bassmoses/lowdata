import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResilientVideoLoader } from '../../src/media/resilientVideo.js';
import type { VideoSource } from '../../src/media/resilientVideo.js';
import { setOnline } from '../helpers/dom.js';
import { waitForCondition } from '../helpers/wait.js';
import { FakeImage } from '../helpers/fakeImage.js';

const SOURCE_A: VideoSource = { src: '/a.mp4', label: 'a' };
const SOURCE_B: VideoSource = { src: '/b.mp4', label: 'b' };
const SOURCES: VideoSource[] = [SOURCE_A, SOURCE_B];
const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 5, jitter: 'none' as const };

describe('createResilientVideoLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setOnline(true);
    window.dispatchEvent(new Event('online'));
  });

  it('arms the first source immediately when online', () => {
    const loader = createResilientVideoLoader({ sources: SOURCES });
    const state = loader.getState();
    expect(state.status).toBe('loading');
    expect(state.videoSrc).toBe('/a.mp4');
    expect(state.sourceIndex).toBe(0);
    loader.destroy();
  });

  it('constructs straight into offline, without arming a source, when offline', () => {
    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    const loader = createResilientVideoLoader({ sources: SOURCES });
    expect(loader.getState()).toMatchObject({
      status: 'offline',
      videoSrc: undefined,
      sourceIndex: -1,
    });
    loader.destroy();
  });

  it('goes straight to exhausted when sources is empty', () => {
    const loader = createResilientVideoLoader({ sources: [] });
    expect(loader.getState().status).toBe('exhausted');
    loader.destroy();
  });

  it('reportPlayable() transitions loading -> playable and resets attempt', () => {
    const loader = createResilientVideoLoader({ sources: SOURCES });
    loader.reportPlayable();
    expect(loader.getState().status).toBe('playable');
    expect(loader.getState().attempt).toBe(0);
    loader.destroy();
  });

  it('reportPlayable() is a no-op once already playable', () => {
    const loader = createResilientVideoLoader({ sources: SOURCES });
    loader.reportPlayable();
    const afterFirst = loader.getState();
    loader.reportPlayable();
    expect(loader.getState()).toEqual(afterFirst);
    loader.destroy();
  });

  it('reportError() falls back to the next source after a backoff delay', async () => {
    const loader = createResilientVideoLoader({ sources: SOURCES, retry: FAST_RETRY });
    expect(loader.getState().sourceIndex).toBe(0);

    loader.reportError('error');
    expect(loader.getState().status).toBe('retrying');
    expect(loader.getState().videoSrc).toBeUndefined();

    await waitForCondition(() => loader.getState().status === 'loading');
    expect(loader.getState().videoSrc).toBe('/b.mp4');
    expect(loader.getState().sourceIndex).toBe(1);
    loader.destroy();
  });

  it('exhausts once every source has failed', async () => {
    const loader = createResilientVideoLoader({ sources: SOURCES, retry: FAST_RETRY });
    loader.reportError('error');
    await waitForCondition(() => loader.getState().status === 'loading');
    loader.reportError('error');

    expect(loader.getState().status).toBe('exhausted');
    expect(loader.getState().videoSrc).toBeUndefined();
    expect(loader.getState().sourceIndex).toBe(-1);
    loader.destroy();
  });

  it('a stall timeout drives the same advance as an explicit reportError()', async () => {
    const loader = createResilientVideoLoader({
      sources: SOURCES,
      stallTimeoutMs: 10,
      retry: FAST_RETRY,
    });

    await waitForCondition(
      () => loader.getState().status === 'loading' && loader.getState().sourceIndex === 1,
      { message: 'expected the stalled first source to be dropped in favor of the second' },
    );
    loader.destroy();
  });

  it('late/duplicate reportError() calls after exhaustion are no-ops', () => {
    const loader = createResilientVideoLoader({ sources: [SOURCE_A], retry: FAST_RETRY });
    loader.reportError('error');
    expect(loader.getState().status).toBe('exhausted');

    const exhaustedState = loader.getState();
    loader.reportError('error again');
    expect(loader.getState()).toEqual(exhaustedState);
    loader.destroy();
  });

  it('retry() restarts the fallback sequence from the top', () => {
    const loader = createResilientVideoLoader({ sources: [SOURCE_A], retry: FAST_RETRY });
    loader.reportError('error');
    expect(loader.getState().status).toBe('exhausted');

    loader.retry();
    expect(loader.getState().status).toBe('loading');
    expect(loader.getState().sourceIndex).toBe(0);
    loader.destroy();
  });

  it('automatically retries once on an offline -> online reconnect edge from offline', () => {
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    const loader = createResilientVideoLoader({ sources: SOURCES });
    expect(loader.getState().status).toBe('offline');

    setOnline(true);
    window.dispatchEvent(new Event('online'));
    expect(loader.getState().status).toBe('loading');
    loader.destroy();
  });

  it('automatically retries once on reconnect from exhausted', () => {
    const loader = createResilientVideoLoader({ sources: [SOURCE_A], retry: FAST_RETRY });
    loader.reportError('error');
    expect(loader.getState().status).toBe('exhausted');

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    expect(loader.getState().status).toBe('loading');
    loader.destroy();
  });

  it('does not interrupt an in-progress/succeeding sequence on a connection change', () => {
    const loader = createResilientVideoLoader({ sources: SOURCES });
    loader.reportPlayable();
    expect(loader.getState().status).toBe('playable');

    setOnline(false);
    window.dispatchEvent(new Event('offline'));
    expect(loader.getState().status).toBe('playable');

    setOnline(true);
    window.dispatchEvent(new Event('online'));
    expect(loader.getState().status).toBe('playable');
    loader.destroy();
  });

  it('poster: blurs up from placeholder to full image, reusing createProgressiveImageLoader', async () => {
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const loader = createResilientVideoLoader({
      sources: SOURCES,
      poster: '/full.jpg',
      posterPlaceholder: '/tiny.jpg',
    });
    expect(loader.getState().poster).toEqual({ src: '/tiny.jpg', isLoaded: false });

    await waitForCondition(() => loader.getState().poster?.isLoaded === true);
    expect(loader.getState().poster).toEqual({ src: '/full.jpg', isLoaded: true });
    loader.destroy();
  });

  it('poster: shows the final poster immediately when no placeholder is given', () => {
    const loader = createResilientVideoLoader({ sources: SOURCES, poster: '/full.jpg' });
    expect(loader.getState().poster).toEqual({ src: '/full.jpg', isLoaded: true });
    loader.destroy();
  });

  it('poster: undefined when neither poster nor placeholder is given', () => {
    const loader = createResilientVideoLoader({ sources: SOURCES });
    expect(loader.getState().poster).toBeUndefined();
    loader.destroy();
  });

  it('destroy() stops further emissions', async () => {
    const loader = createResilientVideoLoader({ sources: SOURCES, retry: FAST_RETRY });
    const listener = vi.fn();
    loader.subscribe(listener);
    loader.destroy();

    loader.reportError('error');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).not.toHaveBeenCalled();
  });

  it('destroy() is idempotent — a second call does not throw', () => {
    // React 18 Strict Mode (and other frameworks' double-invoke dev checks) call an effect's
    // cleanup, then its setup, then its cleanup again — a consumer could plausibly end up calling
    // destroy() more than once on the same instance.
    const loader = createResilientVideoLoader({ sources: SOURCES });
    loader.destroy();
    expect(() => loader.destroy()).not.toThrow();
  });

  it('reportPlayable() after destroy() is a no-op, not a throw', () => {
    // Guards a real race: the consumer's <video> fires onCanPlay just as the component unmounts.
    const loader = createResilientVideoLoader({ sources: SOURCES });
    loader.destroy();
    expect(() => loader.reportPlayable()).not.toThrow();
  });

  it('retry() after destroy() is a no-op, not a throw', () => {
    // Guards a real race: the user taps "retry" just as the component unmounts.
    const loader = createResilientVideoLoader({ sources: SOURCES });
    loader.destroy();
    expect(() => loader.retry()).not.toThrow();
  });
});
