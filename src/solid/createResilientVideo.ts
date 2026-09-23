import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { createResilientVideoLoader } from '../media/resilientVideo.js';
import type { ResilientVideoLoaderOptions, ResilientVideoState } from '../media/resilientVideo.js';

export interface SolidResilientVideo {
  state: Accessor<ResilientVideoState>;
  reportPlayable: () => void;
  reportError: (reason?: string) => void;
  retry: () => void;
}

/** Solid binding over `createResilientVideoLoader` — state as a reactive signal. */
export function createResilientVideo(options: ResilientVideoLoaderOptions): SolidResilientVideo {
  const loader = createResilientVideoLoader(options);
  const [state, setState] = createSignal<ResilientVideoState>(loader.getState());
  const unsubscribe = loader.subscribe((next) => setState(() => next));

  onCleanup(() => {
    unsubscribe();
    loader.destroy();
  });

  return {
    state,
    reportPlayable: () => loader.reportPlayable(),
    reportError: (reason) => loader.reportError(reason),
    retry: () => loader.retry(),
  };
}
