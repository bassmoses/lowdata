# Changelog

All notable changes to this project are documented here. Releases from this point forward are
fully automated by [semantic-release](https://semantic-release.gitbook.io/) — see
[`VERSIONING.md`](./VERSIONING.md) — which prepends a new entry above this line every time a
qualifying commit lands on `master`. Nothing below this line is manually maintained going forward.

## Pre-automation history

### 0.1.0

Initial build, establishing the core feature set (not published to npm under automated
versioning — this repo's first automated release, whatever version semantic-release assigns it,
is the first one actually on the registry):

- **Network layer**: `createLowdataClient()` — a `fetch()` wrapper with automatic retry
  (exponential backoff + jitter), a persistent IndexedDB-backed offline request queue with
  cross-tab locking, automatic sync on reconnect, request prioritization, and cancellation.
- **Offline forms**: `createOfflineForm()` — local autosave, queued/retried submission, and a
  simple `idle → saved → pending → syncing → success` status state machine.
- **Media helpers**: `compressImage()` (canvas-based, connection-aware presets) and
  `createProgressiveImageLoader()` for blur-up placeholders.
- **React bindings**: `useConnectionStatus`, `useLowdataClient`, `useOfflineForm`,
  `useProgressiveImage` under the `lowdata/react` subpath.
- Dual ESM/CJS build with per-subpath entry points (`lowdata`, `lowdata/network`, `lowdata/forms`,
  `lowdata/media`, `lowdata/react`) for tree-shaking, full TypeScript types, zero runtime
  dependencies.
