# Contributing to HUQAN

HUQAN is a maintainer-led repository. Pull requests are reviewed by a human before merge.

**Canonical repository:** `https://github.com/ali-ulu/huqan`

## Before you open a PR

- Keep the scope narrow: one purpose per PR.
- Do not mix runtime code, docs, release metadata, and cleanup unless the task explicitly asks for it.
- Do not use `git add .` or `git add -A`.
- Do not stage runtime artifacts.
- Do not change package version or dependencies unless the scoped task requires it.
- AI-assisted contributions are allowed, but they must be reviewed by a human before merge.

## Local setup

HUQAN currently requires **Node.js 22.13.0 or newer**. Node.js 22 LTS or 24 LTS is recommended. Node.js 20 reached end-of-life on 2026-04-30 and is no longer supported.

```bash
git clone https://github.com/ali-ulu/huqan.git
cd huqan
npm ci
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('SQLite OK')"
npm test
```

For an existing clone that still points to an older repository name:

```bash
git remote set-url origin https://github.com/ali-ulu/huqan.git
git remote -v
```

If you only changed documentation, the full runtime suite may be classified as not applicable by CI when the changed-file policy allows it. Report exactly what did and did not run.

## PR expectations

Include a short summary with:

- branch name
- base and head commit hashes
- files changed
- tests and checks run
- exact results
- anything intentionally not touched
- blockers or unverified items

## Review and release gates

- Human review is required for merge.
- Security-sensitive changes require explicit approval.
- Release tags require clean tests and the expected smoke checks.
- Auto-merge is not used for the main release path.

## Security reports

For security concerns, follow [SECURITY.md](./SECURITY.md).
