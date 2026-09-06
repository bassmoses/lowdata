# lowdata

**Resilience for the other half of the internet.**

Automatic retries with backoff, an offline request queue that survives page reloads, offline-safe
forms, and bandwidth-aware image compression — for web apps that have to keep working on 2G, on a
flaky café Wi-Fi, or mid-load-shedding. Framework-agnostic, near-zero dependencies, fully typed.

[![CI](https://github.com/bassmoses/lowdata/actions/workflows/ci.yml/badge.svg)](https://github.com/bassmoses/lowdata/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/lowdata.svg)](https://www.npmjs.com/package/lowdata)
[![license](https://img.shields.io/npm/l/lowdata.svg)](./LICENSE)
[![bundle size](https://img.shields.io/badge/core%20%2B%20network%20%2B%20forms-~15%20KB%20gzip-brightgreen.svg)](#bundle-size)

```ts
import { createLowdataClient } from 'lowdata';

const client = createLowdataClient();
await client.fetch('/api/orders', { method: 'POST', body: JSON.stringify(order) });
// Online: sends immediately, retrying transient failures automatically.
// Offline (or the server keeps failing): queued to IndexedDB and sent the moment
// connectivity returns — even if the page was reloaded in the meantime.
```

## Why lowdata

Most fetch/UI code silently assumes a fast, stable connection. In much of the world — including
huge parts of Africa — that assumption breaks constantly:

- **Networks drop mid-session.** A form submit or upload just... fails, and the input is gone.
- **Mobile data is expensive.** Every retry, every full-size photo upload, costs real money.
- **"Slow" is the normal case, not the edge case.** 2G/3G and congested Wi-Fi are common, not rare.
- **Reloads happen.** Low-end devices and unstable networks mean tabs get killed and reopened —
  in-progress form input and queued requests need to survive that.

lowdata doesn't try to be a full offline-first framework or a service-worker-based PWA toolkit. It
solves the four concrete problems above, as simply as possible, and gets out of your way otherwise.

## Install

```bash
pnpm add lowdata
# or: npm install lowdata / yarn add lowdata
```

React, Vue, RxJS, and Solid are all **optional** peer dependencies — only needed if you use the
matching `lowdata/react` / `lowdata/vue` / `lowdata/angular` / `lowdata/solid` bindings. Svelte
needs no dependency at all (see [Framework guides](#framework-guides)). Plain `lowdata`/`lowdata/network`/`lowdata/forms` work
from any framework, or none — see [Runtime support](#runtime-support-react-native-electron-node) for
non-browser hosts (React Native, Electron, Node).

## Quick start

### A shop owner in Lagos syncing inventory over 2G

```ts
import { createLowdataClient, isQueued } from 'lowdata';

const client = createLowdataClient({ baseUrl: 'https://api.example.com' });

const result = await client.fetch('/inventory/restock', {
  method: 'POST',
  body: JSON.stringify({ sku: 'RICE-25KG', delta: 40 }),
});

if (isQueued(result)) {
  console.log('Saved locally — will sync automatically once the connection is back.');
} else {
  console.log('Sent immediately:', result.status);
}
```

No polling, no manual retry loop, no lost restock entries when the shop's connection drops mid-tap.

### A rural clinic intake form that never loses data

```ts
import { createOfflineForm } from 'lowdata';

const form = createOfflineForm({ id: 'patient-intake', endpoint: '/api/patients' });

// Call on every field change — cheap, local, and survives a reload or a crashed tab.
await form.save({ name, age, symptoms });

// When the nurse taps "submit": sends now if possible, otherwise queues and syncs later.
const { status } = await form.submit({ name, age, symptoms });
```

```tsx
// React:
import { useOfflineForm } from 'lowdata/react';

function IntakeForm() {
  const { status, submit } = useOfflineForm({ id: 'patient-intake', endpoint: '/api/patients' });
  // status: 'idle' | 'saved' | 'pending' | 'syncing' | 'failed' | 'success'
  return <StatusBadge status={status} />;
}
```

### A marketplace seller uploading a product photo without burning their data bundle

```ts
import { compressImage } from 'lowdata/media';

const { blob, sizeBytes } = await compressImage(photoFile, {
  connectionAware: true, // aggressive on 'slow'/'offline', lighter-touch on 'online'
  targetSizeKB: 200,
});

await client.fetch('/listings/photo', { method: 'POST', body: blob });
```

## Core concepts

### Connection detection

```ts
import { getConnectionQuality, onConnectionChange } from 'lowdata';

getConnectionQuality(); // { quality: 'online' | 'slow' | 'offline', online, effectiveType?, ... }
const unsubscribe = onConnectionChange((info) => console.log(info.quality));
```

Quality is computed from `navigator.onLine`/online-offline events (universal) plus
`navigator.connection` where available (Chromium browsers). On Safari/Firefox, `'slow'` detection
needs an **opt-in** latency probe — never automatic, since every probe costs a little data:

```ts
createLowdataClient({ connection: { pingUrl: '/healthz', slowRttThresholdMs: 600 } });
```

### Offline queue & sync

Every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) that can't be delivered — offline, or the
server keeps failing — is written to IndexedDB and retried automatically, with priority ordering,
exponential backoff + jitter, and a cross-tab lock so two open tabs never double-send the same item:

```ts
await client.queue.add({ url: '/api/x', method: 'POST', priority: 'high', body: json });
await client.queue.list({ status: 'pending' });
await client.queue.cancel(id);
await client.queue.retry(id); // move a 'failed'/'expired'/'cancelled' item back to 'pending'
const unsubscribe = client.queue.subscribe((items) => renderQueueBadge(items.length)); // live in every open tab

client.onSync((event) => {
  // 'sync-start' | 'item-start' | 'item-success' | 'item-failed' | 'item-expired'
  //   | 'items-blocked' (withheld by an unresolved dependsOn, or an open circuit breaker — the
  //     only way to see a stuck item that would otherwise never fire any other event at all)
  //   | 'circuit-open' | 'sync-complete'
});
```

Background sync failures are deliberately never thrown (a queued item retrying in the background
shouldn't crash your app) — but they're not silent either. Pass `onError` to see them (a
`console.warn` is the default if you don't):

```ts
createLowdataClient({
  onError: (error, { scope }) => reportToMonitoring(error, { scope }),
  // scope: 'db-open' (IndexedDB unavailable, fell back to memory for the session)
  //      | 'db-operation' (one IndexedDB call failed — e.g. a transient quota error — persistence
  //        is still available, just that one call fell back)
  //      | 'sync' (the background sync loop hit an unexpected error)
  //      | 'quota' (proactive warning: origin storage is nearly exhausted)
  //      | 'decrypt' (a queued item's body couldn't be decrypted — it's marked 'failed' so it
  //        stops blocking the rest of the queue, but its data is unrecoverable)
});
```

**Ordering dependencies** — don't sync a sale before the product it references has synced:

```ts
const product = await client.queue.add({ url: '/api/products', method: 'POST', body: productJson });
await client.queue.add({
  url: '/api/sales',
  method: 'POST',
  body: saleJson,
  dependsOn: [product.id], // withheld until product.id succeeds (or is cancelled)
});
```

**Expiring stale writes** — never replay a request against data that's likely moved on:

```ts
await client.fetch('/api/checkout', { method: 'POST', body, maxAgeMs: 60_000 }); // 'expired', not sent, after 1 minute queued
```

**Per-endpoint circuit breaker** — many queued items against one persistently-down host back off
together instead of each retrying (and failing) independently:

```ts
createLowdataClient({ circuitBreaker: { threshold: 5, cooldownMs: 30_000 } });
```

**Encryption at rest** — a queued item's `body` is encrypted before it touches IndexedDB and
transparently decrypted on read; every other API (`queue.list()`, `onSync`, `QueuedResult`) always
sees plaintext:

```ts
createLowdataClient({
  encryption: {
    encrypt: (plaintext) => myCrypto.encrypt(plaintext),
    decrypt: (ciphertext) => myCrypto.decrypt(ciphertext),
  },
});
```

**Namespacing** — isolate one client's queue from another's (e.g. per business/tenant), so
switching context can't leak or cross-send another context's queued writes:

```ts
createLowdataClient({ namespace: currentBusinessId });
```

**Pluggable storage** — swap IndexedDB for SQLite/AsyncStorage/anything else by implementing
`StorageAdapter` (five methods: `put`/`get`/`getAll`/`delete`/`clear`/`count` + `isPersistent()`),
useful for an Electron main process or React Native:

```ts
import { createMemoryStorageAdapter, type StorageAdapter } from 'lowdata';

createLowdataClient({ storage: myCustomAdapter }); // or createMemoryStorageAdapter() for tests/SSR
```

**Schema migration** — upgrade queue items enqueued by an older build of your app that are still
pending when the new one runs:

```ts
createLowdataClient({
  schemaVersion: 2,
  migrateQueueItem: (item) => ({ ...item, body: upgradeShape(item.body) }),
});
```

**Idempotency** — every mutating request gets an auto-generated `Idempotency-Key` header (and
`QueueItem.idempotencyKey`) by default, whether it ends up sent live or queued — have your backend
dedupe on it. Opt out with `autoIdempotencyKey: false`, or supply your own via `idempotencyKey`.

### Retry & backoff

```ts
createLowdataClient({
  retry: { maxRetries: 8, baseDelayMs: 500, maxDelayMs: 30_000, jitter: 'full' },
});
```

Retries network errors, timeouts, and `429`/`502`/`503`/`504` (honoring `Retry-After`); `4xx`
responses are returned to you immediately, unretried, so you can handle validation errors normally.

### Offline forms

`createOfflineForm` composes `save()` (local, instant, reload-safe) with `submit()` (send now or
queue) and projects the queue's sync events into a simple status: `idle → saved → pending → syncing
→ success`, with `failed`/`retry()` on the unhappy path.

### Media compression & progressive images

```ts
import { compressImage, createProgressiveImageLoader } from 'lowdata/media';

const loader = createProgressiveImageLoader({ src: fullImageUrl, placeholder: tinyBlurDataUrl });
loader.subscribe(({ src, isLoaded }) => setImgSrc(src));
```

## API reference

| Subpath           | Exports                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lowdata`         | `createLowdataClient`, `LowdataClient`, `isQueued`, `LowdataRequestError`, `createOfflineForm`, `getConnectionQuality`, `onConnectionChange`, `createIndexedDbStorageAdapter`, `createMemoryStorageAdapter`, `CircuitBreaker`, core types |
| `lowdata/network` | Everything in the root, plus `RequestQueue`, `SyncManager`, `ConnectionMonitor`, `defaultRetryOn`, `defaultBreakerKey`, `createQueueBroadcast`                                                                                            |
| `lowdata/forms`   | `createOfflineForm`, form types                                                                                                                                                                                                           |
| `lowdata/media`   | `compressImage`, `createProgressiveImageLoader`, `presetForQuality`                                                                                                                                                                       |
| `lowdata/react`   | `useConnectionStatus`, `useLowdataClient`, `useOfflineForm`, `useProgressiveImage`                                                                                                                                                        |
| `lowdata/vue`     | `useConnectionStatus`, `useLowdataClient`, `useOfflineForm`, `useProgressiveImage` (Composition API)                                                                                                                                      |
| `lowdata/svelte`  | `connectionStatus`, `createOfflineFormStore`, `createProgressiveImageStore`, `createLowdataClient` (stores; zero dependency on `svelte`)                                                                                                  |
| `lowdata/angular` | `connectionStatus$`, `onSync$`, `offlineFormStatus$`, `progressiveImageState$`, `createLowdataClient`, `createOfflineForm` (RxJS Observables)                                                                                             |
| `lowdata/solid`   | `createConnectionStatus`, `createLowdataClient`, `createOfflineForm`, `createProgressiveImage` (Solid primitives)                                                                                                                         |

Full type signatures are in each subpath's shipped `.d.ts` — every export is documented with TSDoc.

## Recipes

**Prioritize a request:**

```ts
await client.fetch('/urgent', { method: 'POST', body, priority: 'high' });
```

**Cancel a stale request:**

```ts
const result = await client.queue.add({ url, method: 'POST', priority: 'normal', body });
await client.queue.cancel(result.id);
```

**Custom retry policy per request:**

```ts
await client.fetch(url, { method: 'POST', body, retry: { maxRetries: 2 } });
```

**Server-side idempotency:** every mutating request carries an auto-generated `idempotencyKey`
(sent as an `Idempotency-Key` header) by default — have your backend dedupe on it, since a retried
or cross-tab-raced request is still possible in rare edge cases.

## Framework guides

Every UI-framework subpath is a thin binding over the same framework-agnostic core (`lowdata`,
`lowdata/forms`, `lowdata/media`) — same `LowdataClient`, same queue, same events. Pick the one
matching your stack; mixing is fine too (e.g. an Angular app can still call `createOfflineForm`
from `lowdata` directly).

- **Vanilla JS / any framework not listed below:** use `lowdata`/`lowdata/forms`/`lowdata/media`
  directly — no framework glue needed, nothing here assumes a specific framework exists.

- **React** (`lowdata/react`): `useConnectionStatus`, `useLowdataClient`, `useOfflineForm`,
  `useProgressiveImage` — plus a re-export of the raw `createLowdataClient`/`LowdataClient` for
  code that needs a client outside a component's lifecycle (a Redux/Zustand store, a module-level
  singleton). `react` is an optional peer dependency (`>=17`).

- **Vue** (`lowdata/vue`): the same four composables (Composition-API-native — `Ref`s, cleaned up
  via `onScopeDispose` — so they work from a bare `effectScope()`, not just inside a component's
  `setup()`) plus the same raw `createLowdataClient`/`LowdataClient` re-export as React, for a
  Pinia store or other non-component usage. `vue` is an optional peer dependency (`>=3`).

  ```ts
  import { useConnectionStatus, useOfflineForm } from 'lowdata/vue';

  const status = useConnectionStatus(); // Ref<ConnectionInfo>
  const form = useOfflineForm({ id: 'clinic-intake', endpoint: '/api/patients' });
  // form.status is a Ref<FormStatus>; form.save/submit/retry are plain async functions
  ```

- **Svelte** (`lowdata/svelte`): stores, not hooks — `connectionStatus()`, `createOfflineFormStore`,
  `createProgressiveImageStore` all return an object satisfying Svelte's store contract
  (`.subscribe(run): unsubscribe`). This subpath needs **no dependency on `svelte` itself** — the
  contract is structural, so `$`-auto-subscription works regardless.

  ```svelte
  <script>
    import { connectionStatus, createOfflineFormStore } from 'lowdata/svelte';
    const status = connectionStatus();
    const form = createOfflineFormStore({ id: 'clinic-intake', endpoint: '/api/patients' });
  </script>
  <p>{$status.quality} — {$form}</p>
  ```

- **Angular** (`lowdata/angular`): RxJS Observables — `connectionStatus$()`, `onSync$(client)`,
  `offlineFormStatus$(form)`, `progressiveImageState$()` — each multicast via `shareReplay` so
  several template `| async` bindings share one underlying listener. No `@angular/core` import, no
  decorators, so there's no Angular-major-version coupling; wrap in your own `@Injectable()`
  service as needed. `rxjs` is an optional peer dependency (`>=7`, already present in virtually
  every Angular app).

  ```ts
  import { connectionStatus$ } from 'lowdata/angular';
  // in a service: readonly status$ = connectionStatus$();
  // in a template: {{ (status$ | async)?.quality }}
  ```

- **Solid** (`lowdata/solid`): primitives following Solid's own `createX` convention —
  `createConnectionStatus`, `createLowdataClient`, `createOfflineForm`, `createProgressiveImage` —
  cleaned up via `onCleanup`, so they work inside any reactive root, not just a component.
  `solid-js` is an optional peer dependency (`>=1`).
  ```ts
  import { createConnectionStatus } from 'lowdata/solid';
  const status = createConnectionStatus(); // Accessor<ConnectionInfo> — call status() to read
  ```

## Multi-tenant apps

Give each tenant its own `LowdataClient`, namespaced — this isolates _everything_ that client
owns: its queue (a separate physical IndexedDB database), its circuit breaker (a fresh instance per
client, never shared across tenants even against the same API origin), and — critically — any
`createOfflineForm` built from it, whose drafts are stored through that same client's own adapter
rather than one hardcoded shared database:

```ts
const client = createLowdataClient({ namespace: currentBusinessId });
const form = createOfflineForm({ id: 'clinic-intake', endpoint: '/api/patients', client });
// Two different businessIds here never share a queue, a draft, or a breaker's failure count.
```

One caveat: `createOfflineForm`/hooks called **without** an explicit `client` fall back to one
lazily-created default (unnamespaced) client, shared by every such call in the process — fine for
single-tenant apps, but always pass your tenant's `client` explicitly in a multi-tenant one.

## Runtime support (React Native, Electron, Node)

The core has no built-in adapter for these — no runtime dependency is added on your behalf — but
every extension point needed to run there is already exposed:

- **Storage**: React Native/Electron's main process/Node have no `indexedDB`. Supply your own
  `StorageAdapter` (SQLite, AsyncStorage, anything with `put`/`get`/`getAll`/`delete`/`clear`/`count`)
  instead of relying on the automatic in-memory fallback:
  ```ts
  createLowdataClient({ storage: myAsyncStorageAdapter });
  ```
- **Connectivity**: without a DOM `window`, lowdata can't hear a browser `online`/`offline` event.
  Feed it your own signal — React Native's `NetInfo`, Electron's own reachability check — and the
  existing reconnect-triggers-a-drain behavior works unchanged:
  ```ts
  NetInfo.addEventListener((state) =>
    client.connection.report({
      online: !!state.isConnected,
      quality: state.isConnected ? 'online' : 'offline',
    }),
  );
  ```
- **Manual sync**: the periodic safety poll relies on `document.visibilityState`, which doesn't
  exist off the DOM either. Call `client.sync()` from whatever _does_ signal "maybe back online"
  there — `AppState` foregrounding, a pull-to-refresh, a cron tick in a Node service:
  ```ts
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void client.sync();
  });
  ```
- `lowdata/media` (Canvas-based image compression) is browser-only and has no fallback — don't
  import it from React Native or Node; it's a separate subpath specifically so you never pay for it
  there.

## Browser & runtime support

- Requires `fetch`, `AbortController`, and `Promise` — all standard in any target browser (and
  present in modern Node/React Native too).
- **IndexedDB** persists the offline queue and form drafts. Where it's unavailable (some SSR
  contexts, locked-down private-browsing modes, React Native/Electron/Node — see above), lowdata
  falls back to an in-memory queue with a console warning instead of throwing — nothing breaks,
  offline persistence is just unavailable until you supply a `storage` adapter.
- **SSR-safe to import**: `createLowdataClient()` and friends never assume `window`/`navigator`
  exist; on the server, connection quality reports `'online'` and nothing touches the DOM.

## Known limitations & roadmap

- **Sync only runs while a tab is open.** There's no Service Worker in v1 (by design — see
  "vs. alternatives" below) — closing the tab while offline defers sync to the next time the app
  is opened, not true background sync.
- **No CRDT/merge conflict resolution.** lowdata detects and reports conflicts (via your backend,
  e.g. comparing a device's timestamp against the server's) but doesn't attempt to auto-merge
  divergent writes — pair its idempotency keys with your own server-side conflict policy.
- **Live cross-tab queue state, storage-quota warnings, and a per-endpoint circuit breaker are all
  implemented** — see `queue.subscribe()`, the `'quota'` error scope, and `circuitBreaker` above.

See [`ROADMAP.md`](./ROADMAP.md) for what's still deliberately deferred and why.

## Bundle size

Sizes below are the unminified ESM build's gzip size — real-world minified size (via your app's
bundler) will be smaller. Each subpath is independently tree-shakeable; you only pay for what you
import.

| Subpath                                                  | gzip (unminified) |
| -------------------------------------------------------- | ----------------- |
| `lowdata` (core + network + forms)                       | ~14.7 KB          |
| `lowdata/network` alone                                  | ~13.5 KB          |
| `lowdata/media` alone                                    | ~3.0 KB           |
| `lowdata/react` / `vue` / `svelte` / `angular` / `solid` | ~15 KB each       |

Framework subpaths are each a standalone bundle (not a thin diff on top of `lowdata`) — importing
one doesn't require also fetching the root package separately.

`lowdata/media`'s image compression (the heaviest single feature — canvas resize + iterative
quality search) is never pulled in by the root import; you opt in explicitly via `lowdata/media`.

## lowdata vs. alternatives

- **vs. Service Worker background sync:** lowdata needs no service worker registration, no
  separate sync event handler, no HTTPS-only constraint for local dev — at the cost of only syncing
  while a tab is open. If you need true background sync after the tab closes, pair lowdata's queue
  format with your own service worker, or wait for a future release.
- **vs. `axios-retry`/generic retry libraries:** those retry a single in-flight request; lowdata
  additionally persists failed/offline requests to survive a reload and syncs them automatically.
- **vs. building it yourself:** this is the boring, well-tested version of the offline queue +
  retry + form-status code most apps end up hand-rolling anyway.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md), [VERSIONING.md](./VERSIONING.md) for the (fully
automated) release process, and [SECURITY.md](./SECURITY.md) to report a vulnerability.

## License

MIT — see [LICENSE](./LICENSE).
