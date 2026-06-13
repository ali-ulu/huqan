# Contributing to AXIOM / HUQAN

AXIOM is a maintainer-led repository. Pull requests are reviewed by a human before merge.

## Before you open a PR

- Keep the scope narrow: one purpose per PR.
- Do not mix runtime code, docs, release metadata, and cleanup unless the task explicitly asks for it.
- Do not use `git add .` or `git add -A`.
- Do not stage runtime artifacts.
- Do not change package version or dependencies unless the scoped task requires it.
- AI-assisted contributions are allowed, but they must be reviewed by a human before merge.

## Local verification

Use the standard local checks for the area you touched:

```bash
npm ci --include=optional
node -e "require('better-sqlite3'); console.log('better-sqlite3 ok')"
npm test
```

If you only changed docs, `npm test` may be optional when the PR scope clearly does not touch runtime behavior.

## PR expectations

Include a short summary with:

- branch name
- commit hash
- files changed
- tests run
- test result
- anything intentionally not touched
- blockers, if any

## Review and release gates

- Human review is required for merge.
- Security-sensitive changes require explicit approval.
- Release tags require clean tests and the expected smoke checks.
- Auto-merge is not used for the main release path.

## Security reports

For security concerns, follow [SECURITY.md](./SECURITY.md).