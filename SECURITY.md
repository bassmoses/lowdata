# Security Policy

## Supported versions

Only the latest published `1.x` release of `lowdata` receives security fixes. There are no
runtime dependencies, so the package's own exposure is limited to its own code — but it does
persist data to IndexedDB and make network requests on the host app's behalf, so issues there are
still very much in scope.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports. Instead:

- Use [GitHub's private vulnerability reporting](https://github.com/bassmoses/lowdata/security/advisories/new)
  for this repository, or
- Email the maintainer directly (see the npm package page for a current contact) with a
  description of the issue, steps to reproduce, and its potential impact.

You should get an acknowledgment within a few days. Once a fix is available, it will be released
as a patch version and the report will be credited (unless you'd prefer otherwise) in the
GitHub Security Advisory and release notes.
