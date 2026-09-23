import { useEffect, useMemo, useState } from 'react';
import { createResilientVideoLoader } from '../media/resilientVideo.js';
import type { ResilientVideoLoaderOptions, ResilientVideoState } from '../media/resilientVideo.js';

export interface UseResilientVideoResult {
  state: ResilientVideoState;
  reportPlayable: () => void;
  reportError: (reason?: string) => void;
  retry: () => void;
}

/**
 * React binding over `createResilientVideoLoader`. `options.sources` must be a stable reference (a
 * module-level constant or memoized array) — an inline array literal creates a new loader, and
 * restarts the whole fallback/backoff sequence, on every render. Wire `reportPlayable`/
 * `reportError` to your own `<video>` element's `onCanPlay`/`onLoadedData`/`onError`/`onStalled`.
 */
export function useResilientVideo(options: ResilientVideoLoaderOptions): UseResilientVideoResult {
  const loader = useMemo(
    () => createResilientVideoLoader(options),
    [options.sources, options.poster, options.posterPlaceholder],
  );
  const [state, setState] = useState<ResilientVideoState>(() => loader.getState());

  useEffect(() => {
    setState(loader.getState());
    const unsubscribe = loader.subscribe(setState);
    return () => {
      unsubscribe();
      loader.destroy();
    };
  }, [loader]);

  return {
    state,
    reportPlayable: () => loader.reportPlayable(),
    reportError: (reason) => loader.reportError(reason),
    retry: () => loader.retry(),
  };
}
