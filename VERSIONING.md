# Versioning policy

`lowdata` follows [semver](https://semver.org/), and releases are fully automated with
[semantic-release](https://semantic-release.gitbook.io/): every push to `master` that passes CI
is analyzed, versioned, published to npm, tagged, and changelogged **with no manual version bump
or `npm publish` step**. There is nothing to run locally to cut a release — the only thing that
determines what happens is your commit messages.

## How it decides the version bump

semantic-release reads [Conventional Commits](https://www.conventionalcommits.org/) on every
commit that lands on `master`:

| Commit message prefix                                                            | Effect               |
| -------------------------------------------------------------------------------- | -------------------- |
| `fix: ...`                                                                       | **patch** release    |
| `feat: ...`                                                                      | **minor** release    |
| `feat!: ...` or a footer of `BREAKING CHANGE: ...`                               | **major** release    |
| `chore: ...`, `docs: ...`, `refactor: ...`, `test: ...`, `ci: ...`, `style: ...` | no release triggered |

If a push contains no `fix`/`feat`/breaking commits, no release happens — this is normal, not an
error. The very first release is always `1.0.0`, regardless of commit type.

## What the automation actually does

On every qualifying push to `master`, CI (`.github/workflows/ci.yml`, the `release` job, gated
behind the `test` and `e2e` jobs passing first):

1. Determines the next version from commits since the last release.
2. Updates `package.json`'s version and prepends a new entry to `CHANGELOG.md`.
3. Runs `npm publish` (via `@semantic-release/npm` — this still runs `prepublishOnly`: typecheck,
   build, and the full unit test suite all have to pass, or the release aborts).
4. Commits the version bump + changelog back to `master`, pushes a git tag, and creates a GitHub
   Release.

### Authenticating to npm

The very first publish of a brand-new package name has to happen with a token — npm's **OIDC
Trusted Publishing** can only be configured against a package that already exists. Sequence:

1. Publish once manually (`npm publish`, once your local `npm whoami` succeeds) **or** add a
   short-lived automation token as a `NPM_TOKEN` repo secret (`gh secret set NPM_TOKEN`) so the
   first CI `release` run can publish instead.
2. Once the package exists on npm: Settings → Trusted Publisher → GitHub Actions, repository
   `bassmoses/lowdata`, workflow `.github/workflows/ci.yml`.
3. Remove the `NPM_TOKEN` secret — the `release` job's `id-token: write` permission is what makes
   OIDC publishing possible from then on, no stored secret needed.

npm is deprecating tokens that bypass 2FA for publishing, so OIDC is the supported long-term path;
`NPM_TOKEN` is a bootstrap-only fallback.

## Local development

You never need to bump a version or run `npm publish` by hand. To preview what the _next_ release
would look like without publishing anything: `npx semantic-release --dry-run` (still needs a
`GITHUB_TOKEN` env var to read releases/tags, but makes no changes).
