## What changed

<!-- Describe the bounded change. -->

## Why

<!-- What problem or issue does this solve? -->

## Evidence

- [ ] Tests added or updated where behavior changed
- [ ] `npm test` (or the relevant scoped suite) passes
- [ ] Conformance / architecture / benchmark checks considered where applicable
- [ ] Package/install behavior considered if public exports, CLI, MCP, REST, dependencies, or packaging changed

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

## Contributor checklist

- [ ] I have read and followed `CONTRIBUTING.md`
- [ ] I have kept the scope narrow (one purpose per PR)
- [ ] I have not mixed runtime code, docs, release metadata, and cleanup
- [ ] I have not used `git add .` or `git add -A`
- [ ] I have not staged runtime artifacts
- [ ] I have not changed package version or dependencies unless required
- [ ] AI-assisted contributions are reviewed by a human
- [ ] I have run `npm run verify` (or the fast `npm run lint && npm run check:cycles && npm run check:module-boundary`) and it passes
- [ ] I have added or updated tests and documentation as appropriate

## Reviewer notes

<!-- Call out risky files, invariants, migrations, generated artifacts, or follow-up work. -->
