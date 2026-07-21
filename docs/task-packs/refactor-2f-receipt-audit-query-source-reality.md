# REFACTOR-2F - Receipt and Audit Query Source Reality

## Gate

- Repository: `ali-ulu/huqan`
- Canonical base: `main @ e08a780e78c3a916b284b47645e2ea3ec5e5a934`
- Previous checkpoint: `REFACTOR-2E5_LEARN_USE_CASE_CLOSEOUT_AUDIT_GREEN`
- Mode: source-reality and ownership decision only

This gate reconciles the `ReceiptAuditQueryUseCase` candidate recorded by
REFACTOR-2B with the current source. It does not authorize runtime changes.

## Decision

`ADAPT` the existing modules. Do not create a new
`ReceiptAuditQueryUseCase`, public Kernel method, facade, wrapper, port,
factory, or dependency.

The required responsibilities are already separated. Rewrapping them would
add indirection without removing a current duplicate implementation.

## Current Owners

| Responsibility | Current owner | Contract |
| --- | --- | --- |
| Audit normalization and filtering | `lib/audit-log.js` | Synchronous primitive functions |
| Audit persistence and query | `Graph.appendAuditEvent()` and `Graph.getAuditEvents()` | Write and read remain distinct |
| Bounded CLI audit append | `Kernel.recordCliMutationAudit()` | Public, synchronous, structured failure |
| Internal best-effort audit append | `Kernel._appendAuditEvent()` | Private, returns `null` on failure |
| Provenance and audit queries | `lib/provenance-query.js` | Read-only query helpers |
| Derived trust receipt | `buildTrustReceipt()` in `lib/provenance-query.js` | Builds a query-time receipt; may add generated ID/time |
| Materialized receipt lookup and export | `lib/receipt/receipt-read-index.js` | Reads only receipts already present in audit details |
| Read-only receipt inspection | `lib/workbench/trust-receipt-inspector.js` | Delegates to the materialized read index |
| HTTP consumers | `server.js` | Calls existing query and receipt helpers directly |

Kernel and KernelV2 do not expose a general receipt or audit query API. This is
an observed compatibility boundary, not a missing feature to fill in this gate.

## Read and Write Boundary

The following paths must not be combined:

- audit append may mutate in-memory and SQLite audit storage;
- audit and provenance query helpers are read-only;
- materialized receipt lookup must not synthesize a replacement receipt;
- derived trust receipt generation is not materialized receipt lookup;
- receipt inspection must not append audit events or mutate Graph state.

`recordCliMutationAudit()` remains the only bounded public Kernel audit append
seam. `_appendAuditEvent()` remains private and is not added to declarations.

## Existing Consumers

- `/api/audit` uses `queryAuditTrail()`;
- `/api/provenance` uses `queryProvenance()`;
- `/api/trust-receipt` uses `buildTrustReceipt()`;
- `/api/trust-receipt/:id` uses `readReceiptById()`;
- the Workbench inspector uses `readReceiptById()`;
- CLI uses `Kernel.recordCliMutationAudit()` and does not query receipts;
- MCP, adapters, and plugins do not require a new receipt-query Kernel facade.

No current consumer needs a new use-case object to preserve behavior.

## Existing Contract Evidence

The current owners already have focused coverage:

- `lib/audit-log.test.js` covers append, filter, workspace, and persistence;
- `lib/provenance-query.test.js` covers provenance, audit, trust graph, and
  derived receipt queries;
- `test/v4-receipt-materialization-read-index.test.js` covers materialized
  receipt lookup, chain validation, cloning, and read-only behavior;
- `test/v4-trust-receipt-read-api.test.js` covers the receipt read HTTP path;
- `test/v4-wb1-trust-receipt-inspector.test.js` covers Workbench inspection;
- `test/kernel-cli-audit-seam-contract.test.js` covers the bounded Kernel write
  seam and failure isolation.

No new characterization test is required merely to introduce another owner
name. Existing tests remain the acceptance suite for this decision.

## Deferred Source Debt

The following observations are real but belong to later named boundaries:

- `queryProvenance()` reads Graph internal collections; direct Graph read-path
  removal belongs to REFACTOR-3 read ownership work;
- `conflict-detector` and `github-connector` retain private-Kernel/public-Graph
  append fallback paths; adapter convergence belongs to REFACTOR-4;
- HTTP coverage for `/api/audit` and `/api/provenance` may be strengthened only
  in a separately justified server contract gate;
- query-time receipt IDs and timestamps are existing derived-receipt behavior,
  not deterministic materialized receipt semantics.

These items do not justify a duplicate 2F runtime abstraction.

## Acceptance

- this document is the only changed file;
- source still contains the named existing owners;
- no package export exposes a new receipt/audit use case;
- existing receipt, audit, provenance, CLI audit, and HTTP receipt tests pass;
- full suite, Security Checks, Benchmark Regression, and Docker build pass;
- independent review confirms the reuse-first decision against live source.

## Stop Conditions

Stop and rescope if a future change requires:

- a new public Kernel or KernelV2 method;
- a receipt, audit-event, verdict, envelope, schema, or version change;
- combining query and append authority;
- changing workspace isolation, cloning, ordering, filtering, persistence, or
  error behavior;
- moving Graph read ownership before REFACTOR-3;
- changing server, MCP, CLI, Workbench, package, dependency, V5, or Policy
  Auditor behavior.

## Non-Claims

- no new use-case implementation exists;
- no receipt or audit public API was added;
- no Graph internal access was removed;
- no append fallback was migrated;
- no receipt determinism claim was expanded;
- REFACTOR-3 and REFACTOR-4 have not started;
- the refactor program is not complete.

## Closeout

After this docs-only gate is independently reviewed, merged, and smoked,
REFACTOR-2F may close as `YAGNI_REUSE_EXISTING`. No implementation successor is
required. The next roadmap gate must be selected from the canonical refactor
program source rather than inferred here.
