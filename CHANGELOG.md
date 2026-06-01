# Changelog

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

