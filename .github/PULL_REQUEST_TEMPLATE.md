## What changed

<!-- Describe the bounded change. -->

## Why

<!-- What problem or issue does this solve? -->

## Evidence

- [ ] Tests added or updated where behavior changed
- [ ] `npm test` (or the relevant scoped suite) passes
- [ ] `npm run verify` passes before push/merge when the change requires the full local gate
- [ ] Conformance / architecture / benchmark checks considered where applicable
- [ ] Package/install behavior considered if public exports, CLI, MCP, REST, dependencies, or packaging changed

### Regression traceability (`fix`, `security`, `hotfix` only)

A defect fix must point at the regression test that pins the failure mode, or
carry a documented waiver. Declare it in the body; `Workflow governance` reads
the line and refuses a fix that names nothing. Ordinary enhancements (`feat`,
`test`, `chore`, `docs`, `ci`, `perf`, `refactor`) and documentation-only
changes are exempt.

```text
Regression-Test: test/check-issue-regression-traceability.test.js
```

```text
Regression-Test: none -- only rewords a refusal message; no runtime path changes
```

A named test must exist, be a discovered test file, and be on the applicable CI
path for the change (selected by the impact plan, or added by this pull
request).

Evidence / commands:

```text

```

## Trust and security boundaries

- [ ] This change does not let a proposing model approve its own mutation
- [ ] Unknown / malformed security-sensitive inputs still fail closed
- [ ] Receipt / provenance integrity is not weakened
- [ ] Workspace / path / authority boundaries are preserved
- [ ] New privileges or trust assumptions are documented

<!-- If any box is not applicable, explain why below. -->

## Public surface impact

- [ ] No public API / CLI / MCP / REST / schema change
- [ ] Public surface change is backward compatible
- [ ] Breaking change is intentional and migration/deprecation guidance is included

## Documentation

- [ ] README / docs / Wiki references updated when user-visible behavior changed
- [ ] Limits and non-claims remain accurate

## Release impact

- [ ] No release impact
- [ ] Patch
- [ ] Minor
- [ ] Major

## Reviewer notes

<!-- Call out risky files, invariants, migrations, generated artifacts, or follow-up work. -->
