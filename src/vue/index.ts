// Vue Composition API bindings — mirrors `lowdata/react`'s hooks one-for-one. `vue` is an optional
// peer dependency: only actually imported by apps that use this subpath.
//
// createLowdataClient/LowdataClient are re-exported alongside the composables (matching
// lowdata/svelte and lowdata/angular) so code that needs a client outside a component's
// lifecycle — a Pinia store, a module-level singleton — can still get one from this single
// subpath instead of also importing from `lowdata` directly.
export { createLowdataClient, LowdataClient } from '../network/client.js';
export type { LowdataClientConfig } from '../network/types.js';
export { useConnectionStatus } from './useConnectionStatus.js';
export { useLowdataClient } from './useLowdataClient.js';
export { useOfflineForm } from './useOfflineForm.js';
export type { UseOfflineFormResult } from './useOfflineForm.js';
export { useProgressiveImage } from './useProgressiveImage.js';
