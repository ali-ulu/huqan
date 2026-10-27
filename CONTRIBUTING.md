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
- The core is licensed under `Apache-2.0`; the paths listed in `LICENSE-ENTERPRISE` are under the HUQAN Enterprise License. Do not change either license, move a file across the boundary, or publish licensing claims through a pull request unless the project owner has approved the exact scope.

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

## Contribution rights

Contributions to the core are accepted under `Apache-2.0` (inbound = outbound, Apache-2.0 section 5). No CLA is required.

External contributions to the paths listed in [`LICENSE-ENTERPRISE`](./LICENSE-ENTERPRISE) are not accepted without a separate written agreement with the project owner (Ali Ulu, `aliulu@ai-ulu.com`).

The canonical licensing record is [`docs/legal/dual-licensing-status.md`](./docs/legal/dual-licensing-status.md); licensing changes are recorded there first, not in pull-request prose.

If a contribution is made in the course of employment or for a client, the contributor must confirm that they have permission to submit it. Contributors must not submit confidential information, credentials, personal data, copied code, or dependency content with incompatible terms.

## PR expectations

Include a short summary with:

- branch name
- base and head commit hashes
- files changed
- tests and checks run
- exact results
- anything intentionally not touched
- blockers or unverified items

## Verification and commit workflow

### Before pushing: run `npm run verify`

`npm run verify` is the comprehensive local pre-push gate. It is driven by
`scripts/verify-suite.js`, which owns the check manifest: environment
check, lint, import cycles, module boundary, layers, file size, GitHub
Action pins, dependency licenses, documentation drift, architecture
trackers, package closure, property tests, and the full test suite.
Checks run fast-first, the run stops at the first failing check, and a
per-check pass/fail summary with timings is printed; any failing check
fails the gate. To add a check to the gate, add a stage to `STAGES` in
`scripts/verify-suite.js` — do not grow a shell chain in `package.json`.

For fast local iteration before the full gate:

```bash
npm run lint && npm run check:cycles && npm run check:module-boundary
```

### Pre-commit hook

A repository template hook runs the fast checks before each commit:

```bash
cp .github/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

The hook is intentionally lightweight. It does not replace `npm run verify`
before pushing.

### Common verification failures

| Failure | What to do |
|---|---|
| Node version check fails | Use Node.js 22.13.0+; Node 22 LTS or 24 LTS is recommended. |
| `check:docs-drift` fails | Update the affected living documentation so it agrees with current source truth. |
| `check:module-boundary` fails | Move cross-module behavior behind the owning module's public facade; see `docs/agent-canon.md`. |
| `check:layers` fails | Fix the import direction according to `docs/architecture.md` and `docs/architecture-policy.md`. |
| `better-sqlite3` native setup fails | Re-run `npm ci` on a supported Node version and verify the local native module install. |
| An unrelated/flaky test fails | Record the exact test and error. Do not claim the full gate is green until the failure is understood or resolved. |

### Commit message format

Use Conventional Commits where practical:

```text
<type>(<scope>): <subject>
```

Common types include `feat`, `fix`, `docs`, `refactor`, `test`,
`chore`, and `ci`. This repository also uses `security` and
`deprecate`.

The changelog is generated from these subjects. `npm run changelog`
prepends the commits since the last tag to `CHANGELOG.md`, filing
`feat` under Added, `fix` under Fixed, `security` under Security,
`deprecate` under Deprecated, a `!` marker or a `BREAKING CHANGE:`
footer under Breaking Changes, and the housekeeping types under
Internal. A subject that does not parse as conventional lands under
Other rather than being dropped. `npm run changelog:preview` prints
the entry without writing the file. The generator is not a gate:
`npm run verify` never reads the changelog back, so a stale entry
cannot fail a push.

### Architecture references

- [Architecture overview](./docs/architecture.md)
- [Architecture policy](./docs/architecture-policy.md)
- [Architecture decision records](./docs/adr/)
- [Stable agent rules](./docs/agent-canon.md)

## Review and release gates

- Human review is required for merge.
- Security-sensitive changes require explicit approval.
- Release tags require clean tests and the expected smoke checks.
- Auto-merge is not used for the main release path.

## Security reports

For security concerns, follow [SECURITY.md](./SECURITY.md).
