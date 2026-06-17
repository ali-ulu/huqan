# Connector Trust Coverage Inventory

Current main: `1d9826fed4a1c7bbdaadd139b9e6c7c567447fe9`

Current classification: `Partial trust layer`

This document is a point-in-time inventory of connector, client, and trust-path coverage on current main. It is intentionally conservative: a path is only `trust-connected` when the tested contract shows gate enforcement, auditable output, and the relevant trust artifacts for that path. If a path is not fully proven end to end, it stays `partially-trust-connected`, `logged-wrapper`, or `api-wrapper`.

## Inventory summary

| Classification | Count |
| --- | ---: |
| `trust-connected` | 11 |
| `partially-trust-connected` | 1 |
| `logged-wrapper` | 1 |
| `api-wrapper` | 1 |
| `unknown` | 0 |

## Contract

A connector/client path can be called `trust-connected` only when all of the following are true for the tested path:

- risky or mutating input passes through a gate before execution
- input/output is auditable
- `sourceType`, `sourceRef`, `actor`, and `workspaceId` are preserved where applicable
- provenance is attached or an explicit rejection is recorded
- graph admission is explicit and never silent
- a receipt or receipt-like decision object exists for review / block / high-risk paths
- restart persistence is tested where state is written

If any of these are not proven for the tested path, the path remains partial.

## Inventory

| path | entrypoint | actionType | mutatesState | callsExternalApi | passesGate | writesGraph | writesProvenance | writesAudit | createsReceipt | persistsAcrossRestart | testCovered | currentClassification | knownGap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `mcpServer.js` | `tools/call` for `axiom.learn`, `axiom.ask`, `axiom.verify`, `axiom.plan`, `axiom.agent`, `axiom.reason`, `axiom.compare`, `axiom.dream`, `axiom.approvals` | `mcp_tool_call` | mixed | no | yes | yes for learn | yes for learn and approval-backed flows | yes | yes for approvals and provenance-backed flows | yes for learned facts and approvals | `test/mcp-server-gate-enforcement.test.js`, `test/mcp-gate-adapter.test.js`, `test/mcp-alpha-smoke.test.js`, `test/mcp-dogfood-client.test.js`, `test/provenance-receipt-bridge.integration.test.js` | `trust-connected` | Verified local MCP dogfood harness exists on the tested current-main path; broader inline enforcement remains partial |
| `server.js` | `/v2/verify`, `/dogrula`, `/verify`, `/yukle`, `/upload`, `/api/ingest`, `/api/provenance`, `/api/audit`, `/api/candidate-claims`, `/api/trust-receipt`, `/api/ingest/status` | `http_api` | mixed | no | yes | yes on POST ingest paths | yes on provenance and trust routes | yes | yes on trust-receipt and approval-adjacent paths | yes where state is written | `server.test.js`, `test/verify-adversarial.integration.test.js`, `test/verify-semantic.integration.test.js`, `test/provenance-receipt-bridge.integration.test.js` | `trust-connected` | Public HTTP surface is proven only on the tested routes, not every hypothetical client path |
| `cli.js` read-only surface | `ask`, `sor`, `verify`, `dogrula`, `why`, `neden`, `compare`, `karşılaştır` | `cli_read` | no | no | yes | no | no | no | no | n/a | `cli.test.js`, `test/cli-english-aliases.test.js` | `trust-connected` | Read-only CLI is proven; it does not need provenance attachment |
| `cli.js` mutating / agent surface | `learn`, `teach`, `öğret`, `yükle`, `upload`, `company-ingest`, `ajan`, `agent`, `plan` | `cli_mutation_or_agent` | yes | mixed | yes | yes for learn and ingest routes | partial | partial | partial | yes for memory/workspace paths | `cli.test.js`, `test/cli-english-aliases.test.js`, `server.test.js`, `test/mcp-server-gate-enforcement.test.js` | `partially-trust-connected` | Dogfood client path is missing; provenance is not universal across every mutation route |
| `adapters/github-adapter.js` | `parseRepoUrl`, `includePath`, `fetchRepoFiles` | `api_wrapper` | no | yes | no | no | no | no | no | no | `adapters/github-adapter.test.js` | `api-wrapper` | Fetching remote repo files is only a source wrapper; trust attachment happens later |
| `adapters/markdown-adapter.js` | `parseMarkdown`, `listMarkdownFiles`, `ingestMarkdown` | `filesystem_wrapper` | no | no | no | no | no | no | no | no | `adapters/markdown-adapter.test.js`, `plugins/repo-memory.test.js` | `logged-wrapper` | Root confinement is proven, but the adapter itself does not attach provenance |
| `plugins/repo-memory.js` | `ingestGithubRepo`, `ingestMarkdownPath`, `run` | `connector_ingest` | yes | yes for GitHub, no for markdown | yes on tested paths | yes | yes on tested paths | yes on tested paths | no | yes on tested paths | `plugins/repo-memory.test.js`, `lib/provenance-query.test.js`, `lib/provenance-ingest.test.js` | `trust-connected` | Tested current-main paths now return explicit admission records |
| `lib/github-connector.js` | `buildGitHubProvenance`, `routeAsPendingCandidate`, `ingestGitHubItem`, `ingestGitHubItems` | `connector_ingest` | yes | no | yes on tested paths | yes | yes | yes | yes on tested paths | yes for stored candidate/audit paths | `lib/github-connector.test.js`, `lib/provenance-query.test.js`, `lib/provenance-ingest.test.js` | `trust-connected` | Candidate routing and explicit admission are proven on tested paths |
| `lib/provenance-ingest.js` | `buildProvenance`, `ingestWithProvenance` | `provenance_ingest` | yes | no | yes | yes | yes | yes | partial | yes | `lib/provenance-ingest.test.js` | `trust-connected` | Strict provenance policy is caller-controlled |
| `lib/provenance-query.js` | `queryProvenance`, `queryTrustGraph`, `buildTrustReceipt` | `provenance_query` | no | no | n/a | no | no | no | yes | n/a | `lib/provenance-query.test.js`, `test/provenance-receipt-bridge.integration.test.js`, `test/causal-receipt-bridge.test.js` | `trust-connected` | Trust receipt generation remains tested on current-main paths |
| `lib/approval-flow.js` | `buildApprovalDecision`, `approveRequest`, `rejectRequest` | `approval_flow` | yes | no | yes | no | yes | yes | yes | yes | `test/approval-flow.test.js`, `test/approval-queue.test.js`, `test/v3-core-smoke.test.js` | `trust-connected` | Approval queue is proven in tests; external client proof is still missing |
| `lib/memory-mutation-gate.js` | `evaluateMemoryMutation` | `memory_gate` | no | no | yes | no | no | no | no | n/a | `test/memory-mutation-gate.test.js`, `test/tool-call-gate.test.js`, `test/v3-core-smoke.test.js` | `trust-connected` | None on the gate contract itself |
| `lib/tool-call-gate.js` | `evaluateToolCall` | `tool_gate` | no | no | yes | no | no | no | no | n/a | `test/tool-call-gate.test.js`, `test/mcp-gate-adapter.test.js`, `test/benchmark-competitive.test.js` | `trust-connected` | None on the gate contract itself |
| `requestGuards.js` | public API unsafe-command guard | `http_cli_guard` | no | no | yes | no | no | no | no | n/a | `server.test.js`, `test/code-change-gate.test.js` | `trust-connected` | HTTP allowlist behavior is proven, but only for the tested commands and routes |

## Trust contract notes

- If a path mutates graph, memory, files, or agent state, it must pass a gate before execution.
- If a path returns a review/block/high-risk result, the response must expose the decision and reason.
- If a path writes graph state, provenance or an explicit rejection record must be observable.
- If a path writes state, restart persistence must be covered by a focused test.
- If a path only wraps a source API or a local filesystem walk, it is not automatically trust-connected.

## Confirmed gaps

- Connector provenance is still partial across the full connector set.
- Connector-to-graph admission is still partial across the full connector set.
- The inline trust boundary is not yet mandatory across every connector and client path.
- `repo-memory` and `github-connector` are trust-connected on the tested current-main paths, but the overall system is still only a partial trust layer because the inline boundary is not mandatory everywhere.

## Stale or non-issues

- `mcpServer.js` gate blocking is not a wrapper-only behavior; the tested path blocks before tool execution, and the local dogfood harness now exercises that boundary.
- `server.js` verification and ingest routes are not open bypasses in the tested paths.
- `cli.js` gate parity is not hypothetical in current main; the mutating and agent routes are routed through gate logic.
- Persistence is not a fake or demo-only layer; the tested JSON and SQLite roundtrips survive reload on current main.

## Recommended next PRs

1. Mandatory inline enforcement matrix
2. Narrow follow-up audit or fix for any connector or HTTP surface that remains only partially trust-connected
3. Final re-audit only after the above remains honestly classified as `Partial trust layer`

## Non-goals

- no broad refactor
- no new connector
- no UI work
- no V4 work
- no release or tag
- no package changes
- no runtime-artifact staging
- no pretending partial coverage is complete
