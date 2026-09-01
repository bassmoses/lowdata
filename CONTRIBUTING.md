# Contributing to lowdata

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev            # tsup --watch
pnpm test:watch      # vitest, watch mode
```

## Before submitting a change

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test
```

`pnpm prepublishOnly` runs typecheck + build + test together, matching what CI should run.

## Design principles

lowdata favors simplicity and reliability over feature count. Before adding something, check it
against the project's actual mission: making apps resilient on poor/expensive/intermittent
connections. If a feature doesn't clearly serve that, it probably belongs in a separate package or
a userland recipe in the README rather than the core.

- **Zero/near-zero runtime dependencies.** Reach for a standard Web API before a package.
- **Tree-shakeable by construction.** New functionality that isn't needed by the common case
  (network + forms) belongs behind its own subpath (see `lowdata/media`, `lowdata/react`), not the
  root barrel.
- **Framework-agnostic core, thin framework bindings.** Logic lives in `src/core`, `src/network`,
  `src/forms`, `src/media`; `src/react` (and any future framework package) should only adapt it.
- **Fail open, not closed.** Environments without IndexedDB or `navigator.connection` should
  degrade gracefully (in-memory queue, optimistic connection assumptions) rather than throw.

## Tests

Tests live under `test/`, mirroring `src/`. IndexedDB is polyfilled via `fake-indexeddb`
(`test/setup/indexeddb.ts`); canvas APIs are stubbed for `compressImage` tests
(`test/setup/canvas.ts`), since jsdom implements neither.

## Commit / PR

Keep changes scoped and covered by tests. Update `CHANGELOG.md` under an "Unreleased" heading for
user-facing changes.
