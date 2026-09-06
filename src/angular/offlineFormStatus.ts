import { Observable } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import type { OfflineForm } from '../forms/offlineForm.js';
import type { FormStatus } from '../forms/types.js';

/** An RxJS Observable of an `OfflineForm`'s status — build the form with `createOfflineForm` (from `lowdata`), then wrap it here for an Angular template's `| async`. */
export function offlineFormStatus$<T>(form: OfflineForm<T>): Observable<FormStatus> {
  return new Observable<FormStatus>((subscriber) => {
    subscriber.next(form.getStatus());
    return form.subscribe((status) => subscriber.next(status));
  }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
}
