import { Observable } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import { getConnectionQuality, onConnectionChange } from '../core/connection.js';
import type { ConnectionInfo } from '../core/types.js';

/**
 * An RxJS Observable of connection status (online / slow / offline) — inject/expose from an
 * Angular service, pipe through `| async` in a template. Multicast via `shareReplay` so multiple
 * subscribers (e.g. several template bindings) share one underlying connection listener rather
 * than each registering its own; the listener tears down once the last subscriber unsubscribes and
 * re-attaches if a new one arrives later.
 */
export function connectionStatus$(): Observable<ConnectionInfo> {
  return new Observable<ConnectionInfo>((subscriber) => {
    subscriber.next(getConnectionQuality());
    return onConnectionChange((info) => subscriber.next(info));
  }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
}
