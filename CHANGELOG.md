# Changelog

All notable changes to this project are documented in this file.

## 0.1.0 — Unreleased

Initial release.

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
