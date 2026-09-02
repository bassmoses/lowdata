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

## Live cross-tab queue state

The cross-tab _lock_ (no double-sends) is real today. A `client.queue.subscribe()` that reactively
updates in every open tab when any tab's queue changes (via `BroadcastChannel` or an IDB
`storage`-event equivalent) would be a nice addition for apps that show queue/sync status in their
UI across multiple tabs. Deferred because most apps only need this in the tab that's actually
submitting.

## Per-endpoint circuit breaker

If an app queues many items against one endpoint that's persistently down, each item currently
retries independently (with jitter, so they don't perfectly synchronize, but also don't
coordinate). A shared circuit breaker per-origin/endpoint could back off the whole group together
after N consecutive failures. Deferred because it's a real scale concern but not a common one —
most apps won't queue enough concurrent items against one failing host to need it.

## Vue-specific subpath

The framework-agnostic core already works fine from a small Vue composable (see README → Framework
guides) — a dedicated `lowdata/vue` subpath with pre-built composables would just save writing
that thin wrapper yourself. Deferred until there's demand; the value-add over the documented
composable pattern is small.

## Proactive storage-quota check

`maxQueueItemSizeBytes` rejects oversized individual items, but doesn't check
`navigator.storage.estimate()` against the _origin's remaining_ quota before attempting to persist
— a nearly-full origin quota still surfaces reactively via `onError`'s `'db-operation'` scope
rather than being caught in advance. Deferred as a smaller, narrower gap than the others here.
