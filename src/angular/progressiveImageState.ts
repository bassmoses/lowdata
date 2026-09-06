import { Observable } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import { createProgressiveImageLoader } from '../media/progressiveImage.js';
import type { ProgressiveImageState } from '../media/progressiveImage.js';

/** An RxJS Observable of blur-up placeholder → full image swap state. See `createProgressiveImageLoader`. */
export function progressiveImageState$(options: {
  src: string;
  placeholder: string;
}): Observable<ProgressiveImageState> {
  // The loader is created *inside* the subscribe callback, not once up front — `shareReplay`'s
  // `refCount: true` tears the source down when the last subscriber leaves and resubscribes if a
  // new one arrives later, which must produce a fresh (not-already-destroyed) loader each time.
  return new Observable<ProgressiveImageState>((subscriber) => {
    const loader = createProgressiveImageLoader(options);
    subscriber.next(loader.getState());
    const unsubscribe = loader.subscribe((state) => subscriber.next(state));
    return () => {
      unsubscribe();
      loader.destroy();
    };
  }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
}
