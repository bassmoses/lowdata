// RxJS-based bindings for Angular. `rxjs` is an optional peer dependency, already present in
// virtually every Angular app — no Angular-version-specific coupling (no `@angular/core` import,
// no decorators), so this works the same across Angular's major versions.
export { createLowdataClient, LowdataClient } from '../network/client.js';
export type { LowdataClientConfig } from '../network/types.js';
export { createOfflineForm } from '../forms/offlineForm.js';
export type { OfflineForm } from '../forms/offlineForm.js';
export { connectionStatus$ } from './connectionStatus.js';
export { onSync$ } from './onSync.js';
export { offlineFormStatus$ } from './offlineFormStatus.js';
export { progressiveImageState$ } from './progressiveImageState.js';
