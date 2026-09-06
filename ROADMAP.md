# Roadmap

Ideas deliberately deferred past v1.0.0, tracked here so they're not forgotten — not a
commitment or a timeline. If one of these matters to you, open an issue.

## Service Worker / true background sync

Today, sync only runs while a tab is open (see README → "Known limitations & roadmap"). A Service
Worker using the [Background Sync API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
could pick up queued items even after the tab closes. Deferred because it adds real complexity
(registration, HTTPS-only in production, a second execution context to keep in sync with the main
one) for a smaller slice of use cases than the core tab-open case — and lowdata's queue format is
already usable from a hand-written service worker today if you need this now.

## CRDT / automatic merge conflict resolution

lowdata detects conflicts (comparing timestamps) and reports them, and provides the primitives
(idempotency keys, `dependsOn` ordering) a backend needs to resolve them deliberately — but it does
not attempt to automatically merge two divergent writes to the same record. Deferred because a
general-purpose merge policy is application-specific (last-write-wins is wrong for some fields,
right for others) — safer to leave the decision to the app/backend than to guess.

---

**Shipped since the list above was written:** live cross-tab queue state (`queue.subscribe()`,
via `BroadcastChannel`), a per-endpoint circuit breaker (`circuitBreaker` config), and a proactive
storage-quota check (the `'quota'` error scope) — see the README's "Offline queue & sync" section.
Also shipped, not originally listed here: a pluggable `StorageAdapter` interface (for non-browser
hosts like Electron's main process or React Native), per-queue-item encryption at rest, `dependsOn`
ordering between queued items, `maxAgeMs` expiry, `queue.retry()`, namespaced/isolated queues per
client (with `createOfflineForm`'s drafts now routed through that same namespace, closing a
cross-tenant leak), queue schema versioning + migration, automatic `Idempotency-Key` generation,
`connection.report()`/`client.sync()` for hosts with no DOM connectivity signal (React Native,
Electron's main process, Node), and dedicated `lowdata/vue`, `lowdata/svelte`, `lowdata/angular`,
`lowdata/solid` subpaths alongside `lowdata/react`.
