# HUQAN / AXIOM V4 Evidence Pack

## Base

```txt
Branch: v4/pr6-demo-evidence-pack
Base branch: claude/practical-knuth-0ecsze
Base HEAD: b544d08e7a25226d7a0f4aa7fe9c27cc7ebb55a6
```

## Raw Evidence Files

- [evidence/v4-pr6/README.md](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/README.md)
- [trust-receipt-inspector-found.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/trust-receipt-inspector-found.json)
- [trust-receipt-inspector-invalid-request.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/trust-receipt-inspector-invalid-request.json)
- [memory-context-inspector-found.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/memory-context-inspector-found.json)
- [memory-context-inspector-read-error.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/memory-context-inspector-read-error.json)
- [mcp-tool-verdict-review.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/mcp-tool-verdict-review.json)
- [mcp-tool-verdict-block.json](C:/tmp/huqan-refactor1a-postmerge-smoke/evidence/v4-pr6/mcp-tool-verdict-block.json)

## Validation Commands

```bash
npm ci
node --test test/v4-mcp-tool-verdict-surface.test.js
node --test test/v4-memory-admission-context-integrity-surface.test.js
node --test test/v4-wb1-trust-receipt-inspector.test.js
node --test test/v4-wb2-memory-context-inspector.test.js
npm test
```

## Validation Results

```txt
test/v4-mcp-tool-verdict-surface.test.js                   7/7 pass
test/v4-memory-admission-context-integrity-surface.test.js 7/7 pass
test/v4-wb1-trust-receipt-inspector.test.js               10/10 pass
test/v4-wb2-memory-context-inspector.test.js              7/7 pass
npm test                                                  1671 / 1642 pass / 0 fail / 29 skipped
git status --short                                        clean
```

## Evidence Interpretation

### E1 Receipt / Verdict Evidence

- WB1 returns a real materialized receipt
- verdict is read from canonical receipt data
- chain validation status is surfaced as `valid`

### E2 Memory Admission Evidence

- PR5 review path exposes `review_required`
- decision is `review`
- provenance workspace remains visible

### E3 Context Integrity Evidence

- current inspected example exposes `workspace_scoped`
- no synthetic canonical mutation flag is invented

### E4 Read-only Invariant Evidence

- both WB1 and WB2 surfaces report `source.readOnly: true`
- PR4 evidence pack also stays read-only

### E5 Fail-closed Evidence

- missing receipt id -> `invalid_request`
- memory/context read source failure -> `read_error`
- unknown MCP tool -> `block`

### E6 Regression Evidence

- targeted V4 surface tests green
- full repository test suite green

### E7 Non-claim / Boundary Evidence

- this pack is docs/evidence only
- no UI, no new API route, no new MCP tool, no package change

## Planned But Not Proven

- Workbench UI
- inspector API beyond existing PR3 receipt read surface
- V5 readiness
- marketplace/badge/conformance
