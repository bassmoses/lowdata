import { Observable } from 'rxjs';
import type { LowdataClient } from '../network/client.js';
import type { SyncEvent } from '../network/types.js';

/** An RxJS Observable view of `client.onSync()` — one subscription per call, matching `onSync`'s own multi-listener contract. */
export function onSync$(client: LowdataClient): Observable<SyncEvent> {
  return new Observable<SyncEvent>((subscriber) => client.onSync((event) => subscriber.next(event)));
}
