# V5 Connector Coverage / Identity + Package Enforcement Matrix

## Status

Planning only.

This document classifies connector and client paths against future Agent
Identity, Shared Trust Package, Route Receipt, Reasoning Metadata, provenance,
and conformance expectations.

It does not implement connectors, identity enforcement, package enforcement,
schemas, validators, conformance runners, runtime behavior, marketplace
behavior, or V5 runtime code.

## Purpose

The Connector Coverage Matrix exists to:

- classify connector and client paths by current trust coverage
- identify Agent Identity coverage gaps
- identify Shared Trust Package and receipt coverage gaps
- identify enforcement gaps
- prevent false "all connectors covered" claims
- prepare future implementation gates without implementing them now

Coverage is path-specific. A tested local path does not imply arbitrary
connector coverage.

## Connector / Client Path Categories

The planning categories are:

- MCP tools
- CLI commands
- HTTP API routes
- local file tools
- GitHub / repo tools
- browser / web tools
- memory adapters
- external SaaS connectors
- A2A / internal agent exchange
- marketplace / package import paths
- Workbench / UI surfaces

## Status Vocabulary

`current_status` values:

- `planned`
- `partial`
- `existing`
- `not_applicable`
- `unknown`

`enforcement_status` values:

- `no_enforcement`
- `docs_only`
- `partial`
- `planned`
- `implemented_future`

`public_claim_status` values:

- `do_not_claim`
- `internal_only`
- `safe_as_planned`
- `safe_as_partial`
- `safe_as_existing_only_after_runtime_evidence`

## Matrix Columns

Future connector coverage rows should track:

- `connector_path`
- `current_status`
- `identity_required`
- `identity_present`
- `workspace_binding_required`
- `workspace_binding_present`
- `shared_trust_package_required`
- `shared_trust_package_present`
- `route_receipt_required`
- `route_receipt_present`
- `reasoning_metadata_required`
- `reasoning_metadata_present`
- `provenance_required`
- `provenance_present`
- `conformance_fixture_required`
- `conformance_fixture_present`
- `enforcement_status`
- `known_gap`
- `future_gate`
- `public_claim_status`

## Connector Coverage Matrix

| connector_path | current_status | identity_required | identity_present | workspace_binding_required | workspace_binding_present | shared_trust_package_required | shared_trust_package_present | route_receipt_required | route_receipt_present | reasoning_metadata_required | reasoning_metadata_present | provenance_required | provenance_present | conformance_fixture_required | conformance_fixture_present | enforcement_status | known_gap | future_gate | public_claim_status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MCP tool call path | existing | future | partial local actor only | yes | partial for tested local path | future | no | future | no | future | partial via toolVerdict surfaces | yes | partial | yes | no | partial | V5 Agent Identity and package enforcement not implemented | V5-PR4 follow-up / implementation readiness audit | safe_as_partial |
| MCP approval / review path | existing | future | partial local approval context | yes | partial | future | no | future | no | future | partial via approval/verdict evidence | yes | partial | yes | no | partial | Identity-bound approval package not implemented | V5-PR4 follow-up / V5-PR5 trust-tier routing | safe_as_partial |
| CLI verify path | existing | future | no V5 identity contract | yes | partial workspace context where provided | future | no | no | no | future | partial via existing verify outputs | yes | partial | yes | no | partial | CLI identity/package boundary not implemented | V5 implementation readiness audit | internal_only |
| CLI learn / memory mutation path | existing | future | no V5 identity contract | yes | partial | future | no | future | no | future | partial via memory admission evidence | yes | partial | yes | no | partial | V5 identity-bound mutation policy not implemented | V5-PR5 trust-tier routing | internal_only |
| HTTP public API verify path | partial | future | no V5 identity contract | yes | partial | future | no | no | no | future | partial where read-only evidence exists | yes | partial | yes | no | planned | External client identity and package verification absent | V5 implementation readiness audit | do_not_claim |
| HTTP protected mutation path | planned | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | docs_only | No V5 protected mutation connector coverage | future implementation gate only | do_not_claim |
| local file action path | partial | future | local process only | yes | partial | future | no | future | no | future | no | yes | partial | yes | no | partial | No package/identity coverage for file actions | V5 implementation readiness audit | internal_only |
| GitHub / repo action path | planned | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | docs_only | GitHub App/repo trust path not proven in V5 | connector-specific audit | do_not_claim |
| browser / web tool path | unknown | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | no_enforcement | Browser/web action boundary not defined | connector coverage audit | do_not_claim |
| memory admission path | existing | future | partial local context | yes | partial | future | no | future | no | yes | partial via contextIntegrity/memoryAdmission | yes | partial | yes | no | partial | V5 identity/package linkage not implemented | V5-PR5 trust-tier routing | safe_as_partial |
| shared trust package import path | planned | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | docs_only | Import verifier/reader not implemented | V5 implementation readiness audit | safe_as_planned |
| route receipt handoff path | planned | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | docs_only | Route receipts are planned only | V5 implementation readiness audit | safe_as_planned |
| A2A internal exchange path | planned | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | docs_only | A2A exchange not implemented | V5-PR6 research note | safe_as_planned |
| marketplace package publish path | planned | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | docs_only | Marketplace publish security not implemented | marketplace security boundary follow-up | do_not_claim |
| marketplace package consume path | planned | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | docs_only | Marketplace consume/import verification not implemented | marketplace security boundary follow-up | do_not_claim |
| Workbench read-only inspector path | existing | future | no V5 identity contract | yes | partial local read-only context | future | no | no | no | future | partial via WB1/WB2 helpers | yes | partial | yes | no | partial | Workbench helpers are read-only and not package connectors | Workbench/V5 boundary audit | safe_as_partial |
| Workbench future action path | planned | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | yes | no | docs_only | Future action path not implemented | future Workbench implementation gate | do_not_claim |

## Gap Discipline

This matrix distinguishes:

- planned coverage
- partial coverage
- runtime evidence
- docs-only claim
- implementation gap
- conformance gap
- public-claim risk

The current V5 planning docs may describe future boundaries. They do not make
those boundaries operational.

## Promotion Rule

A connector path may move toward public claim readiness only when it has:

- declared trust boundary
- explicit Agent Identity mapping
- workspace and delegation scope
- Shared Trust Package or receipt linkage where required
- Route Receipt linkage where crossing boundaries
- Reasoning Metadata boundary where explanations are exported
- provenance references
- connector-specific conformance fixtures
- enforcement evidence
- non-claim statement

No connector path should be promoted from docs-only to runtime coverage without
a dedicated implementation gate and evidence.

## Relationship To Existing V5 Documents

This document maps back to:

- `V5-PR0` Shared Trust / Ecosystem Blueprint
- `LIT-0` source discipline
- `V5-PR1` Agent Identity Contract
- `V5-PR2` Shared Trust Package / Route Receipt / Reasoning Metadata plan
- `V5-PR3` Conformance Suite fixture plan
- future Trust-tier routing plan
- future Marketplace Security Boundary

The matrix is a planning control. It does not replace runtime enforcement,
conformance fixtures, or connector-specific tests.

## Non-Claims

This PR does not claim:

- Connector Coverage Matrix is implemented as runtime enforcement
- connector path is newly enforced
- identity enforcement is added
- package enforcement is added
- schema, validator, or runner is added
- runtime connector coverage is newly proven
- all connectors are covered
- marketplace readiness exists
- production-ready connector governance exists
- V5 implementation is complete

## Next Gates

This document supports the following planning order:

1. `V5-PR4` - Connector Coverage / Identity + Package Enforcement Matrix
2. `V5-PR5` - Trust-tier routing plan
3. `V5-PR6` - A2A / Distributed Trust research note
4. `V5-IMPLEMENTATION-READINESS-0` - implementation gate audit

Anything beyond this remains future planning, not current implementation.

## Safe Claim

Safe current wording:

```txt
HUQAN has opened a connector coverage matrix planning gate to separate tested
paths, partial evidence, and future connector enforcement requirements.
```

Unsafe wording:

```txt
HUQAN covers all connector paths.
HUQAN has production-ready connector governance.
HUQAN enforces identity and package rules across every connector.
HUQAN marketplace connectors are ready.
```
