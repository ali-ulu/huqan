# Runtime Truth Gap Audit - Current Main

## Executive summary

Current main at `7bd60bcb4bdf9fa63f46b16f34502faf8b905925` is not merely an API wrapper or logging scaffold. It has real graph state, verification logic, fail-closed gate behavior, provenance, audit, and Trust Receipt primitives.

However, it is not yet a fully inline, end-to-end enforced trust control plane across every client, connector, CLI, persistence, and approval path.

Correct classification:
`Partial trust layer`

## Audit run

Validation commands and results on current main:

- `npm ci --include=optional` -> pass
- `node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('better-sqlite3 db ok')"` -> pass
- `node --test test/verify-adversarial.integration.test.js test/verify-canonical-lookup.test.js test/verify-semantic.integration.test.js test/semantic-score.test.js` -> pass, `37 pass / 0 fail`
- `node --test cli.test.js test/cli-english-aliases.test.js` -> pass, `40 pass / 0 fail`
- `node --test test/mcp-gate-adapter.test.js test/mcp-server-gate-enforcement.test.js test/mcp-alpha-smoke.test.js test/provenance-receipt-bridge.integration.test.js test/causal-receipt-bridge.test.js test/approval-flow.test.js test/approval-queue.test.js` -> pass, `85 pass / 0 fail`
- `node --test test/entity-provenance-alignment.test.js test/verify-entity-resolution.test.js test/verify-reasoning-trace.integration.test.js` -> pass, `32 pass / 0 fail`
- `node --test test/kernel-persistence-roundtrip.test.js test/memory-package-roundtrip.test.js test/graph-metadata-persistence.test.js` -> pass, `25 pass / 0 fail`
- `node --test test/verify-adversarial.integration.test.js test/verify-canonical-lookup.test.js test/verify-semantic.integration.test.js test/semantic-score.test.js cli.test.js test/cli-english-aliases.test.js` -> pass, `77 pass / 0 fail`
- `npm test` -> pass, `1452 pass / 0 fail / 16 skipped`
- `git diff --check` -> clean

## Confirmed capabilities

### Graph mutation and state

- `graph.js:536-581` persists explicit provenance on learned nodes and edges.
- `graph.js:1012-1088` writes nodes, edges, candidate claims, and audit events to storage.
- `graph.js:1135-1259` reloads graph state from storage and repopulates live structures.
- `kernel.js:394-715` routes learn flow through graph mutation, provenance normalization, and audit/event emission.

### Verify engine logic

- `lib/verify.js:84-130` computes semantic trust signals, weak-match handling, and risk metadata.
- `lib/verify.js:178-305` returns `dogrulandi`, `celiski`, or `bilinmiyor` rather than acting as a thin wrapper.
- `lib/verify.js:633-843` performs contradiction detection and emits structured evidence.
- PR #68 / PR #67 final state is preserved in the current main test results:
  - direct support + contradiction does not return `dogrulandi`
  - direct support without contradiction still returns `dogrulandi`
  - unsupported claim fails closed
  - weak match fails closed

### MCP gate fail-closed behavior

- `mcpServer.js:669-689` blocks tool execution when the gate denies execution and returns a blocked response instead of calling the tool.
- `mcpServer.js:696-730` only executes known tools after gate approval.
- `test/mcp-gate-adapter.test.js` and `test/mcp-server-gate-enforcement.test.js` prove the gate contracts.

### Public API guard behavior

- `server.js:655-683` keeps `/v2/verify` guarded and method-restricted.
- `server.js:753-775` keeps legacy `/dogrula` and `/verify` guarded.
- `server.js:778-904` keeps `/yukle`, `/upload`, and `/api/ingest` behind explicit POST flow and authorization checks.

### Provenance / audit / Trust Receipt infrastructure

- `lib/provenance-query.js:101-198` normalizes provenance and trust receipts.
- `lib/provenance-query.js:238-316` queries provenance, audit events, candidate claims, and receipts from graph state.
- `lib/provenance-query.js:444-580` builds trust receipts from graph/query state.
- `test/provenance-receipt-bridge.integration.test.js` proves provenance-backed learned facts are queryable through graph, receipt, and audit trail.

### Shield auto-learn gate

- `lib/shield.js:35-100` computes shield metadata and only auto-learns when gated conditions are met.

### Test coverage supporting these claims

- `test/verify-adversarial.integration.test.js`
- `test/verify-canonical-lookup.test.js`
- `test/verify-semantic.integration.test.js`
- `test/semantic-score.test.js`
- `test/cli-english-aliases.test.js`
- `test/mcp-gate-adapter.test.js`
- `test/mcp-server-gate-enforcement.test.js`
- `test/mcp-alpha-smoke.test.js`
- `test/provenance-receipt-bridge.integration.test.js`
- `test/causal-receipt-bridge.test.js`
- `test/approval-flow.test.js`
- `test/approval-queue.test.js`
- `test/kernel-persistence-roundtrip.test.js`
- `test/memory-package-roundtrip.test.js`
- `test/graph-metadata-persistence.test.js`
- `test/entity-provenance-alignment.test.js`
- `test/verify-entity-resolution.test.js`
- `test/verify-reasoning-trace.integration.test.js`

## Graph and persistence probe

Observed on current main in a temp directory outside the repo:

- JSON backend:
  - before learn: `nodes=0`, `edges=0`
  - after `learn('kedi hayvandir')`: `nodes=2`, `edges=1`
  - after fresh Kernel reload: `nodes=2`, `edges=1`
- SQLite backend:
  - before learn: `nodes=0`, `edges=0`
  - after `learn('kedi hayvandir')`: `nodes=2`, `edges=1`
  - after fresh Kernel reload: `nodes=2`, `edges=1`

This confirms the learn path mutates real graph state and that learned state survives restart in both JSON and SQLite-backed modes in the tested path.

## Gap / not fully proven areas

- Connector provenance is partial / not proven for every connector path.
- Connector-to-graph end-to-end linkage is partial, not universal.
- Verified MCP dogfood client path was not found.
- CLI, MCP, and HTTP gate enforcement are proven in tested paths, but not every possible connector/client path is covered.
- Approval queue and STOP semantics exist, but not every external client path is proven inline.
- The phrase `fully inline trust layer` is still premature.

## Connector classification

| Connector | Action | CallsExternalApi | WritesGraph | WritesProvenance | WritesAudit | CreatesReceipt | PersistsAcrossRestart | CurrentClassification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `repo-memory` | GitHub repo ingest / markdown ingest | true for repo ingest, false for local markdown ingest | yes | partial | partial | no | partial | `logged-wrapper` |
| `github-adapter` | Repo file fetch | true | no | no | no | no | no | `api-wrapper` |
| `approval-flow` | Approve / reject request | no | no | yes | yes | yes | yes | `trust-connected` |
| `approval-queue` | Request queue management | no | no | partial | yes | partial | yes | `trust-connected` |

Notes:

- `repo-memory` writes graph state and provenance on tested paths, but coverage is not yet universal across every connector path.
- `github-adapter` fetches remote content and does not itself write graph or provenance.
- approval primitives are trust-connected in the tested paths because they produce receipts and audit events.

## Enforcement / HUQAN STOP

### Confirmed

- MCP `callTool` path is inline-blocking for blocked tools in `mcpServer.js:669-689`.
- CLI mutating and risky commands are gated in `cli.js:247-251` and `_evaluateCliGate` / `_formatCliGateMessage`.
- HTTP `/v2/verify`, `/dogrula`, `/verify`, `/yukle`, `/upload`, and `/api/ingest` do not provide silent mutation paths in the tested flow.
- Blocked actions do not execute in the tested MCP and CLI paths.

### Partial

- Not every connector path has the same enforcement depth as MCP/HTTP/CLI tested paths.
- Approval review materialization exists, but end-to-end dogfood proof is missing.

## MCP dogfood

- MCP server is present.
- MCP tools list is present and tested.
- Real verified dogfood client config was not found in this rerun.
- Automated dogfood test path was not verified.

Current interpretation:
`Current MCP server exists, but no verified dogfood client path was found.`

## Final classification

`Partial trust layer`

## Closed findings

- Verify gate failures from PR #68 / TRUTH-1C are closed in current main:
  - direct support + contradiction no longer returns `dogrulandi`
  - unsupported and weak-match claims stay fail-closed
- CLI gate parity from PR #67 is closed in current main:
  - mutating/risky CLI commands are gated
  - read-only CLI commands remain usable
- Persistence restart behavior is proven in the tested JSON / SQLite paths
- Provenance-backed receipts are proven in the tested bridge path
- MCP and HTTP gate enforcement are proven in the tested paths

## Open findings

- Connector provenance coverage remains partial.
- Connector-to-graph linkage is not yet universal across all connectors.
- Verified MCP dogfood client path is absent.
- Full inline trust boundary across every client and connector path remains unproven.

## Recommended next PRs

1. Connector provenance coverage PR
2. Verified MCP dogfood client path PR
3. Narrow follow-up audit/fix PR for remaining connector or HTTP surfaces if new evidence appears
4. V4 blueprint only after the above is reflected honestly as `Partial trust layer`

## Public messaging rules

### Allowed

- local-first partial trust layer
- graph + verify + gate + provenance + receipt primitives
- gated and audited trust foundation
- not merely an API wrapper or logging scaffold

### Not allowed

- fully inline trust layer
- end-to-end enforced agent control plane
- production-grade autonomous trust engine
- guarantees truth
- all client and connector paths are covered

## Non-goals

- no runtime fix in this PR
- no release prep
- no claim expansion
- no marketing copy expansion
- no new feature work
