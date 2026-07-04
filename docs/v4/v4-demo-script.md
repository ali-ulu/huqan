# HUQAN / AXIOM V4 Demo Script

## Purpose

This script is the operator-facing walkthrough for the PR6 evidence pack. It uses real runtime-derived outputs already captured under `evidence/v4-pr6/`.

## Demo Sequence

### 1. Trust Receipt / Verdict proof

Command used to collect evidence:

```bash
node -
```

Input summary:

- `kernel.learn('marti hayvandir', approved provenance...)`
- `inspectTrustReceipt({ source: kernel.graph, receiptId, workspaceId: 'pr6-wb1' })`

Show:

- [trust-receipt-inspector-found.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/trust-receipt-inspector-found.json)

Call out:

- `status: "found"`
- `verdict: "allow"`
- `chainStatus: "valid"`
- `source.readOnly: true`

Then show fail-closed:

- [trust-receipt-inspector-invalid-request.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/trust-receipt-inspector-invalid-request.json)

Call out:

- no fake receipt
- no fake verdict
- explicit `invalid_request`

### 2. Memory Admission / Context Integrity proof

Input summary:

- real `callTool(kernel, { name: 'axiom.learn', ... })` review path
- read through `inspectMemoryContext(...)`

Show:

- [memory-context-inspector-found.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/memory-context-inspector-found.json)

Call out:

- `memoryAdmission.status: "review_required"`
- `memoryAdmission.decision: "review"`
- `contextIntegrity.flags: ["workspace_scoped"]`
- `source.readOnly: true`

Then show fail-closed:

- [memory-context-inspector-read-error.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/memory-context-inspector-read-error.json)

Call out:

- explicit `read_error`
- no thrown success-like fallback

### 3. MCP Tool Verdict proof

Show:

- [mcp-tool-verdict-review.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/mcp-tool-verdict-review.json)
- [mcp-tool-verdict-block.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/mcp-tool-verdict-block.json)

Call out:

- `axiom.learn` queues review rather than silently mutating
- unknown tool blocks fail-closed
- memory admission metadata and tool verdict metadata align

## Regression Proof

Run and show exact test lines from [v4-evidence-pack.md](C:/tmp/huqan-refactor1a-postmerge-smoke/docs/v4/v4-evidence-pack.md):

- `test/v4-mcp-tool-verdict-surface.test.js`
- `test/v4-memory-admission-context-integrity-surface.test.js`
- `test/v4-wb1-trust-receipt-inspector.test.js`
- `test/v4-wb2-memory-context-inspector.test.js`
- `npm test`

## Demo Guardrails

Do not say:

- production-ready enterprise control plane
- V5 ready
- all connectors covered
- truth guaranteed
- hallucinations eliminated

Do say:

- read-only evidence helpers exist
- current proof is repo-backed and runtime-derived
- this is a pre-V5 evidence pack
