import { describe, expect, it } from 'vitest';
import { createResilientVideoLoader } from '../../src/media/resilientVideo.js';
import { resilientVideoState$ } from '../../src/angular/resilientVideoState.js';
import type { VideoSource, ResilientVideoState } from '../../src/media/resilientVideo.js';

const SOURCES: VideoSource[] = [{ src: '/a.mp4' }, { src: '/b.mp4' }];

describe('resilientVideoState$ (angular/rxjs)', () => {
  it('emits the current loader state immediately, then updates on reportPlayable()', () => {
    const loader = createResilientVideoLoader({ sources: SOURCES });
    const states: ResilientVideoState[] = [];
    const subscription = resilientVideoState$(loader).subscribe((state) => states.push(state));

    expect(states[0]?.status).toBe('loading');
    expect(states[0]?.videoSrc).toBe('/a.mp4');

    loader.reportPlayable();
    expect(states[states.length - 1]?.status).toBe('playable');

    subscription.unsubscribe();
    loader.destroy();
  });

  it("unsubscribing does not destroy the loader — that remains the caller's responsibility", () => {
    const loader = createResilientVideoLoader({ sources: SOURCES });
    const subscription = resilientVideoState$(loader).subscribe(() => {});
    subscription.unsubscribe();

    expect(() => loader.getState()).not.toThrow();
    loader.destroy();
  });
});
