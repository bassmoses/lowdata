import { useEffect, useMemo, useState } from 'react';
import { createProgressiveImageLoader } from '../media/progressiveImage.js';
import type { ProgressiveImageState } from '../media/progressiveImage.js';

/** Blur-up placeholder → full image swap, as reactive state. See `createProgressiveImageLoader`. */
export function useProgressiveImage(options: {
  src: string;
  placeholder: string;
}): ProgressiveImageState {
  const loader = useMemo(
    () => createProgressiveImageLoader(options),
    [options.src, options.placeholder],
  );
  const [state, setState] = useState<ProgressiveImageState>(() => loader.getState());

  useEffect(() => {
    setState(loader.getState());
    const unsubscribe = loader.subscribe(setState);
    return () => {
      unsubscribe();
      loader.destroy();
    };
  }, [loader]);

  return state;
}
