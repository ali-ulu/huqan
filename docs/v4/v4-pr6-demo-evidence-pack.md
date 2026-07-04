# HUQAN / AXIOM V4-PR6 Demo / Evidence Pack

## Status

Current checkpoint:

```txt
V4_HARDENING_1_DECISION_COMPLETE
```

Canonical branch:

```txt
claude/practical-knuth-0ecsze
```

Canonical HEAD:

```txt
b544d08e7a25226d7a0f4aa7fe9c27cc7ebb55a6
```

This pack is a docs/evidence implementation of PR6. It packages real runtime-derived evidence from existing V4 read surfaces and helper modules. It does not add runtime behavior, UI, API, MCP tools, or package changes.

## What Is Proven

The current V4 runtime surface can expose real, read-only evidence across three runtime families:

- Trust Receipt / verdict evidence through the receipt primitive and WB1 inspector
- Memory Admission / Context Integrity evidence through the PR5 surface and WB2 inspector
- MCP tool verdict evidence through the PR4 surface

The pack also records fail-closed outcomes and read-only invariants using the current runtime helpers.

## Verified Components

- V4-PR2 verdict reconciliation
- V4-PR2.5 receipt primitive
- V4-PR2.6 receipt read index
- V4-PR3 trust receipt read surface
- V4-PR4 MCP tool verdict surface
- V4-PR5 memory admission / context integrity surface
- WB1 Trust Receipt / Verdict Inspector
- WB2 Memory Admission / Context Integrity Inspector
- BRAIN-0 Judge Engine Architecture Note
- REFACTOR-1A MCP response builder extraction

## Evidence Classes

```txt
E1 - Receipt / Verdict Evidence
E2 - Memory Admission Evidence
E3 - Context Integrity Evidence
E4 - Read-only Invariant Evidence
E5 - Fail-closed Evidence
E6 - Regression Evidence
E7 - Non-claim / Boundary Evidence
```

Each evidence class is backed by files under `evidence/v4-pr6/` plus the validation commands recorded in [v4-evidence-pack.md](./v4-evidence-pack.md).

## Demo Path

### Path A - Trust Receipt / Verdict

- Input / action: approved `kernel.learn(...)` with provenance in workspace `pr6-wb1`
- Expected verdict: `allow`
- Read surface: `lib/workbench/trust-receipt-inspector.js`
- Evidence output: [trust-receipt-inspector-found.json](../../evidence/v4-pr6/trust-receipt-inspector-found.json)
- Fail-closed pair: [trust-receipt-inspector-invalid-request.json](../../evidence/v4-pr6/trust-receipt-inspector-invalid-request.json)
- Tests proving behavior:
  - `test/v4-wb1-trust-receipt-inspector.test.js`
  - `test/v4-trust-receipt-read-api.test.js`
  - `test/v4-receipt-materialization-read-index.test.js`

### Path B - Memory Admission / Context Integrity

- Input / action: `callTool(kernel, { name: 'axiom.learn', ... })` in workspace `pr6-wb2`
- Expected verdict family: `review` with memory admission review metadata
- Read surface: `lib/workbench/memory-context-inspector.js`
- Evidence output: [memory-context-inspector-found.json](../../evidence/v4-pr6/memory-context-inspector-found.json)
- Fail-closed pair: [memory-context-inspector-read-error.json](../../evidence/v4-pr6/memory-context-inspector-read-error.json)
- Tests proving behavior:
  - `test/v4-wb2-memory-context-inspector.test.js`
  - `test/v4-memory-admission-context-integrity-surface.test.js`

### Path C - MCP Tool Verdict

- Input / action: `axiom.learn` via MCP tool call and `axiom.unknown` fail-closed probe
- Expected verdicts:
  - `axiom.learn` -> `review`
  - `axiom.unknown` -> `block`
- Read surface: existing MCP tool verdict envelope from `mcpServer.js`
- Evidence output:
  - [mcp-tool-verdict-review.json](../../evidence/v4-pr6/mcp-tool-verdict-review.json)
  - [mcp-tool-verdict-block.json](../../evidence/v4-pr6/mcp-tool-verdict-block.json)
- Tests proving behavior:
  - `test/v4-mcp-tool-verdict-surface.test.js`
  - `test/mcp-server-gate-enforcement.test.js`

## Read-Only Invariant

This pack uses read surfaces only. The evidence sources above do not create receipts, mutate memory, mutate graph state, approve actions, or alter MCP/public API behavior.

## Planned, Not Proven

The following are still outside the proof boundary:

- Workbench UI
- inspector API endpoints beyond existing PR3 receipt read API
- MCP inspector tool surface
- connector-wide inline enforcement claims
- V5 readiness

## Non-Claims

This pack does not claim:

- production-ready full control plane
- V5 readiness
- marketplace readiness
- public release readiness
- truth guarantee
- hallucination elimination
- all unsafe actions prevented
- all connectors/client paths covered
- Workbench UI implementation

## File Guide

- Overview and proof boundary: this file
- Operator/demo walkthrough: [v4-demo-script.md](./v4-demo-script.md)
- Validation and test evidence: [v4-evidence-pack.md](./v4-evidence-pack.md)
- Raw evidence files: [README.md](../../evidence/v4-pr6/README.md)
