# Changelog

## v0.9.0

Prepared 2026-06-03.

### Notes
- Final release metadata aligned after clean-clone blocker fixes passed.
- `/v2-status` now reflects the v0.9 final release metadata and static test status.
- No verifier behavior changes in this patch.

## v0.8.0

Prepared 2026-06-02.

### Added
- Trust Kernel and AXIOM Trust Protocol release prep.
- Provenance schema enforcement and strict provenance handling.
- Trust policy config and provenance ingestion helper.
- Append-only audit log core.
- Workspace scoping and SQLite indexes.
- Conflict detection and candidate claim quarantine.
- Provenance-aware GitHub connector.
- Provenance Query API and Trust Dashboard.
- Trust Receipt support.
- ATP/AVP v0.1 specs and conformance suite.
- `.axiom` package format draft and validator.
- Minimal `axiom-verify` package skeleton.
- Serial test runner to avoid test race conditions.

### Notes
- `.axiom` is an exchange format, not runtime storage.
- ATP v0.1 is not v1.0.
- `axiom-verify` validates structure and semantics; it does not prove absolute truth.

## v0.7.0

Released 2026-06-01.

### Added
- Causal reasoning line promoted from `v0.7.0-rc.1`.
- Causal relation support with `CAUSES`, `PREVENTS`, `ENABLES`, `DEPENDS_ON`, and `LEADS_TO`.
- Deterministic causal traversal with loop detection and max-depth stopping.
- Deterministic what-if causal simulator output.
- Causal finalizer summaries with risk, evidence, recommendation, and next questions.
- Deterministic demo for `autoLearn default true` risk analysis.

### Known limitations
- Not a full world model.
- No probabilistic prediction layer.
- No UI integration for the causal branch.
- No enterprise governance or multi-user permissions layer.
- Causal relations are still structured inputs, not autonomous discovery.

### Tests
- 392/392 passing.

## v0.7.0-rc.1

Branch: `v0.7-causal-wip`

### Added
- Causal relation support with `CAUSES`, `PREVENTS`, `ENABLES`, `DEPENDS_ON`, and `LEADS_TO`.
- Deterministic causal traversal with loop detection and max-depth stopping.
- Deterministic what-if causal simulator output.
- Causal finalizer summaries with risk, evidence, recommendation, and next questions.
- Deterministic demo for `autoLearn default true` risk analysis.

### Known limitations
- Not a full world model.
- No probabilistic prediction layer.
- No UI integration for the causal branch.
- No enterprise governance or multi-user permissions layer.
- Causal relations are still structured inputs, not autonomous discovery.

### Tests
- 392/392 passing.

## v0.6.0

Released 2026-06-01.

### Added
- Productization & Shield release promoted from `v0.6.0-rc.1`.
- Finalized v0.6 UI polish, Shield layer, ingest separation, demo smoke, and SDK wrappers.
- Release metadata aligned across package version, README, and release notes.

### Tests
- 348/348 passing.

## v0.5.0-agent-os-discovery

Released 2026-06-01.

### Added
- Workflow Agent OS runtime with deterministic `workflow-agent.js` plan/run core.
- `workflow-runtime.js` as the opt-in orchestration layer for agent + tools.
- Workflow tool adapters for:
  - `verifyClaim`
  - `findContradictions`
  - `rankEvidence`
  - `repoMemory`
  - `companyBrain`
  - `discoveryEngine`
  - `experimentPlanner`
  - `resultAnalyzer`
  - `replicationChecker`
  - `runCapability`
  - `getGraphStats`
- Discovery objective support in `workflow-agent.js` with discovery-specific tool order and step inputs.
- Workflow runtime opt-in via `AXIOM_AGENT_RUNTIME=workflow`.

### Changed
- `repoMemory` and `companyBrain` are treated as Agent OS tools, not standalone phases.
- README status now reflects shipped Workflow Agent OS and discovery skeleton support.

### Tests
- 331/331 passing.

