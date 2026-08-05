# V4-WB2 Memory Context Product-Runtime Evidence Authorization

## Authorization identity

- Repository: `ali-ulu/huqan`
- Exact authorization base: `main @ 829e38f66c30ebe353cbab90b1d017fa68887c99`
- Package version: `0.9.1`
- Active roadmap gate: `V4_WORKBENCH_RUNTIME_EVIDENCE_0_AUTHORIZATION`
- Selected remaining boundary: V4-B1 Memory Admission / Context Integrity
  Inspector product-runtime evidence
- This document authorizes one future test-only source-reality gate. It does
  not authorize runtime wiring.

## Executive decision

The Trust Receipt Inspector half of V4-B1 already has an authenticated product
route and no-mock real-server evidence. The remaining V4-B1 gap is WB2, the
Memory Admission / Context Integrity Inspector.

WB2 must not be routed from the transient MCP response used by its current unit
test, and no new persistence model may be invented before current durable
source reality is characterized.

The next gate is therefore exactly:

```text
V4_WB2A_MEMORY_CONTEXT_RUNTIME_SOURCE_CONTRACT_TESTS
```

It may add or modify exactly one test owner:

```text
test/v4-wb2-memory-context-runtime-source.test.js
```

No production file is authorized.

## Directly observed source reality

### Existing WB2 helper

`lib/workbench/memory-context-inspector.js` is a read-only normalizer. It can
read from a supplied function or object source and returns bounded
`invalid_request`, `not_found`, `read_error` or `ok` states.

Its current test owner, `test/v4-wb2-memory-context-inspector.test.js`, builds a
memory-admission result through an MCP test double, adds an artificial
`recordId`, and supplies an in-memory `readMemoryContext()` source. That proves
the helper contract, not product-runtime reachability or durable later lookup.

### MCP response surface

`lib/mcp/response-builders.js` builds the public `memoryAdmission` surface on a
tool response. It carries status, verdict, reason, workspace, provenance and
context-integrity flags, but that response object is not itself a durable
record store.

### Current durable audit source

`Graph` owns an append-only audit log in SQLite and mirrors the canonical audit
state into its JSON fallback. `Graph.appendAuditEvent()` writes normalized
records; `Graph.getAuditEvents()` reads bounded cloned records with workspace,
event, target, actor, provenance and source filters.

`lib/learn-use-case.js` records real learn admission outcomes through that audit
owner:

- review/reject paths append `REVIEW` or `REJECT` events for target type
  `learn`, including the reason, `admissionOutcome`, approval status and any
  materialized admission receipt;
- admitted learn paths append `LEARN` or `REAFFIRMED` edge events after a real
  canonical edge operation and include the materialized admission receipt when
  present.

`kernel.js` shows that admission receipt details contain only an existing
`receiptId` and a defensive copy of the existing receipt. It does not fabricate
one.

### Current uncertainty

The current audit source is durable, but the repository does not yet have a
source-backed contract proving that its exact fields are sufficient to
reconstruct the WB2 inspector input without inventing context, mutation or
provenance claims.

That uncertainty must be resolved by tests before any adapter, route or UI
surface is authorized.

## Authorized future test gate

The future test-only PR must start from the exact post-merge main produced by
this authorization and change exactly:

```text
test/v4-wb2-memory-context-runtime-source.test.js
```

It must use real current runtime owners. No fake memory-admission records, fake
receipts, fake context-integrity objects or injected production substitutes are
allowed.

### Required characterization

The test owner must attempt to prove all of the following against the real
`Kernel` and real `Graph` audit path:

1. A real review-required learn attempt produces one queryable audit record
   with exact workspace, event type, target type, target identity, reason and
   admission outcome.
2. The review record remains queryable after closing and reopening the real
   SQLite-backed Graph.
3. A real admitted learn operation produces queryable audit evidence only
   after the canonical operation and exposes no fabricated receipt or mutation
   field.
4. An admitted record's canonical-mutation conclusion can be tied to real
   source evidence, not inferred only from a caller-provided flag.
5. Exact workspace filtering prevents cross-workspace record leakage.
6. An unknown record identifier returns no record and does not fall back to a
   different workspace or target.
7. Reading the audit record does not change nodes, edges, audit rows, receipts,
   approval state or package files.
8. Receipt and provenance links are copied only when present in the real audit
   event.
9. The test records which stable identifier can safely be used by a later WB2
   read surface. Prefer `auditId`; do not overload mutable text or positional
   order as identity.
10. The test explicitly decides whether current audit records contain enough
    source-backed information to feed `inspectMemoryContext()` without
    synthesizing absent semantics.

### Required verdict

The test-only gate must end in exactly one of these source-backed outcomes:

```text
V4_WB2_RUNTIME_SOURCE_SUFFICIENT
V4_WB2_RUNTIME_SOURCE_BLOCKED_GAP
```

`V4_WB2_RUNTIME_SOURCE_SUFFICIENT` is allowed only when the tests prove a
bounded mapping for status/decision/reason, workspace, provenance and canonical
mutation from current durable records.

`V4_WB2_RUNTIME_SOURCE_BLOCKED_GAP` is required if any mandatory WB2 field would
need to be invented, guessed or derived from caller-controlled data. In that
case, stop and authorize a separate persistence/product decision. Do not patch
runtime inside the test PR.

## Acceptance commands

The future test-only PR must run:

```bash
node --test test/v4-wb2-memory-context-runtime-source.test.js
node --test test/v4-wb2-memory-context-inspector.test.js
node --test test/v4-memory-admission-context-integrity-surface.test.js
node --test test/v4-wb1-trust-receipt-inspector.test.js
npm test
npm pack --dry-run --json --ignore-scripts
git diff --check
git diff --name-only <exact-base>...HEAD
git status --short
```

Acceptance requires:

- exact one-file test scope;
- all targeted tests and full regression exit `0` with zero failures;
- real SQLite close/reopen evidence;
- no mutation caused by inspection;
- package surface unchanged;
- exact-head Security Checks and Benchmark Regression successful;
- zero unresolved review threads; and
- explicit `SUFFICIENT` or `BLOCKED_GAP` verdict backed by assertions.

## Successor sequence

If the source contract is sufficient:

```text
V4_WB2A_MEMORY_CONTEXT_RUNTIME_SOURCE_CONTRACT_TESTS
-> V4_WB2A_RECONCILIATION
-> V4_WB2B_AUDIT_SOURCE_ADAPTER_AUTHORIZATION
```

A later adapter gate may normalize the already-proven audit record into the
existing inspector input. It must remain read-only and must not modify
`graph.js`, `kernel.js`, `server.js` or `mcpServer.js` with new domain logic.
Any eventual HTTP wiring requires its own route-contract, implementation and
no-mock real-server gates.

If the source contract is insufficient:

```text
V4_WB2A_MEMORY_CONTEXT_RUNTIME_SOURCE_CONTRACT_TESTS
-> V4_WB2A_RECONCILIATION
-> V4_WB2_PERSISTENCE_PRODUCT_DECISION_AUTHORIZATION
```

No adapter or route may start before that product decision.

## Forbidden scope

This authorization and its test successor forbid:

- production, route, server, MCP, CLI, UI or package implementation changes;
- a new database table, index, store, migration, schema or dependency;
- adding MemoryStore to the learn path;
- mutating Graph, memory, receipts, approval state or audit history during
  inspection;
- caller-supplied workspace, identity, admission, receipt or mutation claims
  becoming authority;
- synthetic context reconstruction or inferred provenance when absent;
- changing existing WB1/WB3 routes or receipt semantics;
- V4-B2, V4-B3, V4-B5 or V5 work;
- production-readiness, V4-complete or V5-complete claims.

## Stop conditions

Stop the future test gate without runtime repair if:

- a stable durable record cannot be selected without scanning ambiguous text;
- allowed/reviewed/rejected outcomes cannot be distinguished from current
  evidence;
- canonical mutation cannot be tied to an actual recorded operation;
- workspace isolation cannot be proven;
- a new persistence field, schema or public API is required; or
- exact test scope cannot remain one file.

## Connector-only limits

During this authorization, local clone bootstrap,
`node scripts/agent-context.js`, local worktree state, local `git diff --check`,
Graphify refresh and local test commands were not available through the
connector environment. Exact live source, Git ancestry, changed-file scope and
GitHub CI remain controlling evidence for this docs-only gate.

## Non-claims

This document does not claim that:

- WB2 is product-runtime reachable;
- current audit records are already sufficient;
- a memory-context HTTP route exists;
- a new persistence model is authorized;
- Workbench is complete;
- production external-client enablement is ready; or
- V5 implementation has started.
