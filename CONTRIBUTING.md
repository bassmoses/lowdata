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
pnpm test:e2e   # real-browser smoke tests — requires `pnpm build` first; see e2e/README.md
```

`pnpm prepublishOnly` runs typecheck + build + test together. CI (`.github/workflows/ci.yml`) runs
all of the above — typecheck/lint/format/build/test as one matrixed job across Node 18/20/22, and
the e2e suite as a separate job — on every push and PR to `master`.

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
  `src/forms`, `src/media`; `src/react`/`src/vue`/`src/svelte`/`src/angular`/`src/solid` (and any
  future framework package) should only adapt it, never duplicate it.
- **Fail open, not closed.** Environments without IndexedDB or `navigator.connection` should
  degrade gracefully (in-memory queue, optimistic connection assumptions) rather than throw.

## Tests

Tests live under `test/`, mirroring `src/`. IndexedDB is polyfilled via `fake-indexeddb`
(`test/setup/indexeddb.ts`); canvas APIs are stubbed for `compressImage` tests
(`test/setup/canvas.ts`), since jsdom implements neither.

## Commit / PR

Keep changes scoped and covered by tests. Commit messages must use a
[Conventional Commits](https://www.conventionalcommits.org/) prefix (`fix:`, `feat:`, `feat!:` +
`BREAKING CHANGE:` footer, or `docs:`/`chore:`/`refactor:`/etc. for no release) — releases,
version numbers, and `CHANGELOG.md` are all fully automated from them; see
[`VERSIONING.md`](./VERSIONING.md). Don't hand-edit `CHANGELOG.md`.
