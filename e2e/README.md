# e2e — real-browser smoke tests

Unit tests (`test/`) run against jsdom + `fake-indexeddb`, which simulate the browser APIs
lowdata's core value proposition depends on — they don't exercise the real thing. Two guarantees
specifically can't be verified there at all:

- **Real network-offline state.** jsdom tests fake `navigator.onLine` by hand; here,
  `page.context().setOffline(true)` toggles the actual browser's connectivity.
- **Real multi-tab behavior.** jsdom is a single global — there's no way to represent "two open
  tabs." Here, two independent Playwright `Page`s share one browser context's storage, exactly
  like two real tabs on the same origin.

## Running locally

```bash
pnpm build       # e2e tests exercise the real dist/ output, not source
pnpm test:e2e
```

The first run downloads Chromium if it isn't already installed:
`pnpm exec playwright install chromium`.

## What's covered

- `queue-persistence.spec.ts` — queue a request while offline, reload the page, confirm the
  queued item survived in real IndexedDB, then confirm it auto-syncs once back online.
- `cross-tab-lock.spec.ts` — two tabs, one queued item, both come online together: confirms
  exactly one network request was made, not two.

This is a smoke suite, not a substitute for the unit tests — it exists only to cover what jsdom
structurally cannot.
