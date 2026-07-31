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

## TB-A2 Production Source-Reality Reconciliation

This section reconciles the production entry points inventoried by `TB-A1` at
`main @ 3969f141a668fb6084d45e9730102f7e7b2c02e3` against canonical `main @
34ffd1928d9705c2e2f17fe587a553a99bcc65c4`. It is the authoritative
current-runtime view for `TB-A2`. The planning rows above remain a future
coverage register and must not override the path-specific evidence below.

`none` means that the production invocation does not provide the named trust
property. `partial` means that a local mechanism exists but is not the V5
identity, package, or route-receipt contract.

Three dimensions are reported independently:

- `production_reachability`: `production-reachable`, `conditional-production`,
  `library-only`, or `operator-only`
- `implementation_state`: `implemented`, `partial`, or `planned`
- `v5_enforcement_state`: `absent`, `partial-local`, or `enforced`

| path | production_reachability | implementation_state | v5_enforcement_state | note |
| --- | --- | --- | --- | --- |
| CLI GitHub ingest | production-reachable | implemented | absent | Live repository-read and proposal path. |
| CLI Markdown ingest | production-reachable | partial | absent | Invocable, but the caller omits the required root binding and receives `MARKDOWN_ROOT_REQUIRED`. |
| Workflow GitHub `repoMemory` | conditional-production | implemented | absent | Enabled only by explicit workflow-runtime configuration. |
| Workflow Markdown `repoMemory` | conditional-production | partial | absent | Invocable when workflow runtime is enabled, but the request omits the required root binding. |
| HTTP ingest approval queue | production-reachable | partial | partial-local | Manual/decision approval is implemented; external sources are rejected. |
| MCP mutation / approval | production-reachable | implemented | partial-local |
| Viewer receipt gateway | production-reachable | implemented | absent | Local read-only authentication is not V5 enforcement. |
| Programmatic SDK | production-reachable | implemented | absent |
| Package Kernel API | production-reachable | implemented | absent |
| V5 runtime writer / reader | library-only | implemented | absent | No production connector caller. |
| `packages/axiom-verify` | library-only | implemented | absent | Structural verification only; no production connector caller. |
| Backup/restore and training | operator-only | implemented | absent |

| production path | identity coverage | workspace binding | package validation | provenance and audit | receipt production / read | mutation owner | failure behavior | open blocker |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CLI GitHub repository ingest | No V5 identity. The plugin uses the local `github` actor default. | No caller-bound workspace reaches the plugin; it uses `default`. | None. | `repo-memory` builds provenance. Allowed Kernel proposals append Graph audit, but audit is not an atomic journal. | Proposal admission may return a local `receiptId`; no V5 Route Receipt is written or read. | `Kernel.runCapability()` -> `PluginManager` -> `repo-memory` -> `Kernel.proposeNode()` / `proposeEdge()` -> Graph. | Connector and capability errors return failure. Audit append failure does not roll back an admitted mutation. | Caller identity/workspace binding and durable route-receipt ownership are absent. |
| CLI Markdown ingest | No V5 identity. The plugin would use the local `markdown` actor default. | No caller-bound workspace reaches the plugin; it uses `default`. | None. | The downstream plugin can build file provenance, but the current CLI invocation does not reach proposals because it omits the required root binding. | No receipt is produced on the blocked current invocation. | Intended chain is `Kernel.runCapability()` -> `PluginManager` -> `repo-memory` -> markdown adapter -> Kernel proposal -> Graph. | Current invocation fails with `MARKDOWN_ROOT_REQUIRED`; invalid roots also fail closed. | Required root binding, caller identity/workspace binding, and durable route-receipt ownership are absent. |
| Workflow `repoMemory` tool | No V5 identity. Workflow `author` is not propagated as the plugin's `actor`. | The request schema does not carry `workspaceId`; the plugin uses `default`. | None. | GitHub uses the `repo-memory` provenance and Kernel proposal audit path. Markdown is blocked before proposal because the request omits the required root binding. | GitHub may return the same local proposal result as CLI; blocked Markdown produces no receipt. No V5 Route Receipt contract exists. | Workflow tool -> capability runner -> Kernel -> plugin -> Graph for admitted GitHub proposals. | Capability failures return a workflow tool failure envelope; current Markdown invocation returns `MARKDOWN_ROOT_REQUIRED`. | Effective actor identity and caller workspace are lost, and Markdown root binding is absent. |
| HTTP ingest approval queue | Local `http-api` actor only; not V5 Agent Identity. | Approval receipts use the local `default` workspace. | None. | Approval state is persisted and audit is appended after finalization. This is not connector provenance for rejected external sources. | Writes and reads local approval receipts; these are not V5 Route Receipts. | Approval queue/store owns review state; approved manual/decision execution reaches the Kernel capability. | GitHub and Markdown queue admission fail closed with `INGEST_SNAPSHOT_REQUIRED`. | Immutable GitHub/Markdown snapshot support is absent, so external connector queueing is intentionally unavailable. |
| MCP mutation and approval paths | Local MCP tool and approval context only; not V5 Agent Identity. | Local/default workspace behavior; no connector-scoped V5 binding. | None. | Tool verdict and approval evidence are partial local audit evidence. | Persists local approval records; no V5 Route Receipt writer. | MCP gate/approval store, then Kernel for approved execution. | Mutation is gate-controlled and rejected or queued according to policy. | No GitHub connector MCP tool and no V5 identity/package enforcement. |
| Viewer receipt HTTP gateway | Session/API-key authentication; not V5 Agent Identity. | An optional workspace filter constrains reads; it does not bind an execution. | None. | Read-only; it does not append execution audit. | Reads already materialized local receipts and does not synthesize or write receipts. | None beyond the bounded in-process session store. | Missing authentication, invalid filters, and unknown receipts fail closed. | This is a receipt consumer, not connector execution or route-receipt enforcement. |
| Programmatic SDK | Caller-controlled local library context; no V5 identity binding. | Only caller-provided command options; no enforced connector workspace contract. | None on command dispatch. | Depends on the selected Kernel read, learn, shield, or capability path. | No SDK-wide V5 Route Receipt contract. | The selected Kernel method or plugin owns mutation. | Failure behavior is method-specific; the SDK is not an external transport boundary. | A caller can select behavior without an identity/package enforcement layer. |
| Package Kernel API | Caller-controlled process identity only. | Caller-controlled constructor and method inputs. | No automatic package validation at the Kernel entry point. | Method-specific provenance and Graph audit; neither is universal identity evidence. | Method-specific local receipts only; no public approval or V5 Route Receipt method. | Kernel, plugin, Graph, or persistence helper according to the invoked method. | Method-specific; direct consumers bypass HTTP/MCP approval ownership. | The canonical library surface is intentionally not a governed connector transport. |
| V5 runtime writer / reader | Validates bounded Agent Identity fields in package data; it does not authenticate a live connector caller. | Validates package workspace fields; no production connector binds them to an authenticated actor. | Bounded Shared Trust Package and Route Receipt validation is implemented. | Validates package provenance/reasoning fields; it does not observe live connector execution. | Validates and returns bounded in-memory package data, including optional Route Receipt metadata; it performs no serialization or durable receipt I/O, and no production connector caller was found. | Writer/reader only; no Graph, memory, plugin, or connector mutation. | Invalid bounded input returns structured fail-closed results. | Implemented library contract is not wired to a production import/export boundary. |
| `packages/axiom-verify` | Not applicable to connector invocation. | Not applicable. | Existing library-only structural Axiom package validation; no proven production caller. | None. | Can validate receipt-shaped package fields structurally; it does not observe or write live route execution. | None. | Invalid packages return validation errors to the library caller. | Structural library validation is not production Shared Trust Package import enforcement. |
| Backup/restore and training utilities | Local process identity only. | Configuration/path scoped; no V5 workspace identity binding. | None. | No connector provenance contract. | No V5 Route Receipt contract. | Backup/restore helpers own persistence; training uses Kernel/Graph. | Script and persistence errors propagate to the operator. | These are operator utilities, not connector transports. |

### Source Anchors

- CLI connector calls: `cli.js:495-520`
- Workflow request construction: `workflow-tools.js:246-305`
- Connector actor/workspace defaults: `plugins/repo-memory.js:147-180`
- Kernel capability and proposal ownership: `kernel.js:326-432`
- HTTP immutable-snapshot rejection: `lib/ingest.js:149-167`
- HTTP approval persistence and execution: `server.js:1149-1292`
- Receipt read boundary: `lib/receipt/receipt-read-index.js:122-177`
- V5 bounded package writer/reader: `lib/v5/runtime-writer.js:160-279` and
  `lib/v5/runtime-reader.js:67-293`
- Structural package validation: `packages/axiom-verify/index.js` and
  `lib/axiom-package-format.js:276-337`
- Non-atomic Graph audit boundary: `kernel.js:592-598`
- Full production call chains: `docs/audits/production-connector-client-call-chain-inventory.md`

### Unknowns and Blocking Gaps

1. No production connector invocation binds V5 Agent Identity end to end.
2. CLI and workflow connector calls do not preserve caller workspace identity.
3. No production connector invokes Shared Trust Package validation.
4. Connector provenance may be default-filled and is not identity proof.
5. Direct connector paths do not own a V5 Route Receipt write contract.
6. Graph mutation and audit append do not share an atomic durability boundary.
7. HTTP GitHub/Markdown queueing remains unavailable until immutable snapshot
   semantics are defined and implemented.
8. Direct `handleIngest()` dispatch capability means the HTTP queue's
   fail-closed snapshot rule must not be generalized to every caller.

Existing local approval receipts and receipt reads are local mechanisms;
they are not V5 Route Receipt enforcement. Existing Axiom package validation
is a library-only structural boundary; it is not production Shared Trust
Package import enforcement.

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
