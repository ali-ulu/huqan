# Runtime Truth Gap Audit — Partial Trust Layer Classification

## Executive summary

HUQAN / AXIOM is not merely an API wrapper or logging scaffold. It has real graph state, verification logic, fail-closed gate behavior, provenance, audit, and Trust Receipt primitives.

However, it is not yet a fully inline, end-to-end enforced trust control plane across every client, connector, CLI, persistence, and approval path.

Correct classification:
`Partial trust layer`

## Confirmed capabilities

### Graph mutation and state

- `graph.js:250-264` initializes real graph state containers (`_nodes`, `_edges`, `_auditEvents`) and SQLite capability wiring.
- `graph.js:919-925` exposes workspace-aware node/edge counts from the live graph state.
- `graph.js:1012-1018` performs real save/flush behavior.
- `graph.js:1135-1142` clears and reloads graph state.

### Verify engine logic

- `lib/verify.js:84-130` computes semantic trust signals, including weak partial-match and risk detection.
- `lib/verify.js:178-230` derives status, confidence, warnings, and semantic trust output.
- `lib/verify.js:245-305` returns `dogrulandi`, `celiski`, or `bilinmiyor` rather than acting as a thin wrapper.
- `lib/verify.js:633-743` runs contradiction detection over graph state.
- `lib/verify.js:834-843` converts contradictions into structured evidence.

### MCP gate fail-closed behavior

- `mcpServer.js:669-687` blocks tool execution when the gate denies execution and returns a blocked response instead of calling the tool.
- `mcpServer.js:322-345` defines gate response shape with explicit action / approval / blocked semantics.

### Public API guard behavior

- `requestGuards.js:10-43` defines unsafe public API command blocking and a conservative allowlist.
- `requestGuards.js:75-88` normalizes and classifies command text before public execution.
- `requestGuards.js:127-145` enforces API-key checks.

### Provenance / audit / Trust Receipt infrastructure

- `lib/provenance-query.js:101-165` normalizes provenance, candidate claims, audit events, and receipts.
- `lib/provenance-query.js:238-295` queries provenance from graph state.
- `lib/provenance-query.js:328-590` queries audit trails, candidate claims, trust graphs, and builds trust receipts.

### Shield auto-learn gate

- `lib/shield.js:35-100` computes shield metadata and only auto-learns when gated conditions are met.

### Test coverage supporting these claims

- `test/mcp-server-gate-enforcement.test.js:22-33` proves mutating tools are blocked.
- `test/mcp-server-gate-enforcement.test.js:38-49` proves dry-run-only tools are blocked from execution.
- `test/mcp-server-gate-enforcement.test.js:54-67` proves read-only tools still pass.
- `test/mcp-server-gate-enforcement.test.js:96-105` proves unknown tools are fail-closed.
- `test/tool-policy.test.js:6-35` proves the policy engine is fail-closed for unknown external tools.
- `test/causal-receipt-bridge.test.js:92-101` proves receipt output remains backward-compatible without adding causal state.
- `test/causal-receipt-bridge.test.js:257-286` proves receipt building does not write audit events and remains deterministic.
- `test/verify-canonical-lookup.test.js:84-110` proves canonical verify behavior does not mutate graph state.
- `test/verify-canonical-lookup.test.js:161-179` proves verify is read-only.
- `test/verify-adversarial.integration.test.js:27-55` proves adversarial inputs are surfaced as risk metadata.

## Gap / not fully proven areas

- Persistence default / restart roundtrip was not fully proven in this audit.
- Connector provenance is partial / not proven for every connector path.
- CLI/dogfood client path is not fully end-to-end gated.
- Dogfood client was not proven.
- Approval queue / dry-run / STOP semantics are not fully proven as inline enforcement.
- The phrase “fully inline trust layer” is premature.

## Classification table

| Claim                        | Status                       |
| ---------------------------- | ---------------------------- |
| Graph mutation real          | confirmed                    |
| Verify is only wrapper       | false                        |
| MCP gate fail-closed         | confirmed                    |
| Public API guard             | confirmed                    |
| Provenance / audit / receipt | confirmed                    |
| Persistence restart proof    | gap / not fully proven       |
| Connector provenance         | partial / gap                |
| CLI gate path                | gap                          |
| Dogfood client               | gap                          |
| Approval queue               | partial / needs verification |
| Inline trust layer           | partial                      |

## Public messaging rules

### Allowed

- partial local-first trust layer
- graph + verify + gate + provenance + receipt primitives
- gated and audited trust foundation
- not merely a logging scaffold

### Not allowed

- fully inline trust layer
- end-to-end enforced agent control plane
- production-grade autonomous trust engine
- guarantees truth
- all client and connector paths are covered

## Recommended next TRUTH sequence

Do not implement these in this audit. They are the next verification packages:

1. `TRUTH-1 — contradiction threshold / celiski gap`
2. `TRUTH-2 — persistence restart roundtrip + provenance attachment`
3. `TRUTH-3 — CLI/MCP/dogfood path enforcement`
4. `TRUTH-4 — approval/dry-run/STOP semantics`

## Non-goals

- no runtime fix in this PR
- no release prep
- no claim expansion
- no marketing copy expansion
- no new feature work

