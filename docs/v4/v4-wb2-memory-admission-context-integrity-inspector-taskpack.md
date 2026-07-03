# HUQAN / AXIOM V4-WB2 Task-Pack - Memory Admission / Context Integrity Inspector

## Current checkpoint

```txt
V4_WB1_IMPLEMENTATION_MERGED_POST_MERGE_SMOKE_GREEN
Canonical HEAD: a2384b465868087c0ede0f029e2fec736097a779
```

This document defines the WB2 implementation boundary only. It does not
implement WB2.

## Purpose

WB2 will define a future read-only inspector for memory admission and context
integrity evidence.

It must only read existing runtime outputs. It must not approve memory writes.
It must not mutate memory. It must not mutate graph state. It must not
reconstruct missing context. It must not fake admission or integrity results.

## Product boundary

WB2 is defined as:

```txt
A read-only inspector that answers:
- Was a memory write admitted, reviewed, blocked, or rejected?
- Which context integrity signals were present?
- Which workspace/context/provenance fields were available?
- Was canonical state mutated?
- Which receipt/trace evidence links the decision?
```

It may display real fields only:

- `workspaceId`
- `memoryAdmission.status`
- `memoryAdmission.decision`
- `memoryAdmission.reason`
- `contextIntegrity.status`
- `contextIntegrity.flags`
- `canonicalMutation`
- `provenance`
- `traceId`
- `receiptId`
- `source`
- `missingFields`

It must not:

- create memory
- mutate memory
- approve or reject pending memory writes
- write graph state
- execute tools
- synthesize context
- reconstruct missing provenance
- claim complete Workbench

## Existing source surfaces

Allowed future implementation sources:

```txt
- PR5 memory admission / context integrity surface
- Existing MCP memory/context evidence only when read-only
- Existing Trust Receipt / trace links only when real
- WB1 Trust Receipt Inspector helper only as read-only supporting evidence
```

The future implementation PR must inspect actual PR5 runtime and test surfaces
before implementation begins.

Required source inspection list for the future implementation PR:

- `test/v4-memory-admission-context-integrity-surface.test.js`
- `mcpServer.js` only for read contract inspection, not mutation
- `lib/workbench/trust-receipt-inspector.js` only for supporting read-only receipt linkage
- related receipt/read-index tests when receipt linkage is used

## Future implementation candidates

The future implementation PR may choose only one narrow path, based on repo
reality.

Preferred future path:

```txt
lib/workbench/memory-context-inspector.js
test/v4-wb2-memory-context-inspector.test.js
```

Optional alternative only when justified:

```txt
lib/workbench/memory-admission-inspector.js
lib/workbench/context-integrity-inspector.js
test/v4-wb2-memory-context-inspector.test.js
```

The future implementation PR must choose one path only. Do not combine helper,
UI, API, and MCP work in one PR.

## Preferred implementation path

Preferred WB2 implementation:

```txt
read-only helper + targeted test first
```

Reason:

```txt
This proves memory/context inspection from real runtime evidence before UI or external surfaces exist.
```

## Read-only invariant

```txt
WB2_READ_ONLY_INVARIANT:
For the same input state, WB2 inspection must not change:
- memory
- graph
- receipts
- audit log
- approval queue
- MCP tool state
- package/version files
- runtime artifacts
```

## Fail-closed behavior

Future implementation behavior:

```txt
Missing input:
return invalid_request, not fake data.

Unknown memory admission / context record:
return not_found, not synthetic result.

Read source failure:
return read_error with stable reason.

Missing optional fields:
return partial result with missingFields list.

Workspace mismatch:
return not_found or forbidden_or_not_found.

No cross-workspace leakage.
No synthetic context reconstruction.
No inferred provenance when provenance is absent.
```

## No-mock rule

```txt
No fake memory admission records.
No fake context integrity verdicts.
No hardcoded demo context.
No synthetic provenance.
No synthetic canonical mutation status.
No mock data in production/pitch/release/readiness claims.
```

## Required future tests

Future WB2 implementation tests:

```txt
1. missing input returns invalid_request
2. unknown memory/context record returns not_found
3. real memory admission evidence can be inspected
4. real context integrity evidence can be inspected
5. canonicalMutation is displayed only from real evidence
6. missing optional fields appear in missingFields
7. throwing read source returns read_error
8. inspection does not mutate memory
9. inspection does not mutate graph
10. inspection does not create receipts
11. workspace boundary is respected
12. WB1 Trust Receipt Inspector regression remains green when receipt linkage is used
13. PR5 memory/context regression remains green
```

## Future validation commands

Future implementation validation:

```bash
npm ci
node --test test/v4-wb2-memory-context-inspector.test.js
node --test test/v4-wb1-trust-receipt-inspector.test.js
node --test test/v4-memory-admission-context-integrity-surface.test.js
node --test test/v4-trust-receipt-read-api.test.js
npm test
git diff --name-only <base>..HEAD
git status --short
```

## Non-claims

This task-pack does not claim:

- WB2 is implemented
- Workbench UI exists
- memory writes are structurally impossible
- all context corruption is prevented
- production enterprise control plane is ready
- all connector/client paths are covered
- all unsafe actions are prevented
- HUQAN guarantees truth
- HUQAN eliminates hallucinations
- PR6 has started
- V5 is ready
- marketplace/badge/conformance is ready
- public release readiness

## Future PR exit gate

Future implementation exit gate:

```txt
V4_WB2_IMPLEMENTATION_READY_FOR_READ_ONLY_REVIEW
```

Required future evidence:

- exact files changed
- targeted WB2 inspector test pass
- WB1 inspector regression pass
- PR5 memory/context regression pass
- full `npm test` pass
- no memory/graph/receipt/approval mutation during inspection
- no fake memory/context/provenance data
- worktree clean

## Validation commands for this docs-only PR

```bash
npm ci
npm test
git diff --name-only a2384b465868087c0ede0f029e2fec736097a779..HEAD
git status --short
```

Expected:

- `npm ci` pass
- `npm test` pass
- changed files remain docs-only
- no runtime/test/package/UI files changed
- `git status --short` clean after commit

## Final statement

This PR defines the WB2 implementation task-pack only.

It does not implement the Memory Admission / Context Integrity Inspector,
Workbench UI, HTTP API, MCP tool, approval mutation, memory mutation, graph
writes, synthetic context reconstruction, PR6 demo pack, V5 readiness,
marketplace, badges, conformance, or public release claims.
