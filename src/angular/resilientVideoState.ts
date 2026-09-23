import { Observable } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import type { ResilientVideoLoader, ResilientVideoState } from '../media/resilientVideo.js';

/**
 * An RxJS Observable of a `ResilientVideoLoader`'s state — build the loader with
 * `createResilientVideoLoader` (re-exported from this subpath), then wrap it here for an Angular
 * template's `| async`. Unsubscribing from the returned Observable only releases *this*
 * subscription — it does not call `loader.destroy()`, since the loader is owned by whoever created
 * it, not by this wrapper. Call `loader.destroy()` yourself (e.g. in `ngOnDestroy`) or its
 * connection-monitor subscription and any pending stall/retry timer leak.
 */
export function resilientVideoState$(
  loader: ResilientVideoLoader,
): Observable<ResilientVideoState> {
  return new Observable<ResilientVideoState>((subscriber) => {
    subscriber.next(loader.getState());
    return loader.subscribe((state) => subscriber.next(state));
  }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
}
