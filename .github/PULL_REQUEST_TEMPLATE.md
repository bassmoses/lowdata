## Summary

<!-- What does this PR change and why? -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm test` all pass locally.
- [ ] New/changed behavior has test coverage (`test/`, and `e2e/` if it touches real
      IndexedDB/cross-tab/offline behavior).
- [ ] Public API changes are reflected in the README.
- [ ] Commit message(s) use a [Conventional Commits](https://www.conventionalcommits.org/) prefix
      (`fix:`, `feat:`, `feat!:` + `BREAKING CHANGE:` footer, or `docs:`/`chore:`/`refactor:`/etc.
      for no release) matching the semver impact described in `VERSIONING.md` — releases are fully
      automated from commit messages, there is no manual version bump step.
