# V5 Human Oversight MCP Production Wiring Closeout

status: implemented
implementation_commit: 10bb023
verification: 45 targeted tests passed; known agent-context baseline exception remains outside this slice

## Scope

This slice wires the existing Human Oversight & Approval Runtime into the MCP approval ingress behind an explicit opt-in configuration boundary. The default MCP path remains unchanged when no `humanOversightRuntime` is configured.

The runtime is created before the approval decision and is reconstructed from the persisted MCP approval row. For `huqan.learn`, the persisted row carries a bounded `oversightRequired` marker only when the opt-in runtime is active. The approval decision path then replays the durable review case, records the approval or rejection through the existing Human Oversight Runtime, and sends approved execution through `executeApproved` so requester identity, approver separation, action scope, expiry, firewall version, and execution outcome are revalidated before `kernel.learn` runs.

The approved execution path is Promise-aware without changing the legacy synchronous path. The existing approval-store finalization and canonical receipt path remains the source of the MCP approval receipt. Human Oversight case, decision, and execution receipts are projected into a bounded `oversight` response surface.

## Invariants preserved

| Invariant | Implementation evidence |
|---|---|
| Opt-in migration boundary | `createServer` and `callTool` preserve legacy behavior when `humanOversightRuntime` is absent. |
| Fail-closed execution | Missing runtime, unreadable case, failed decision, firewall mismatch, or unknown execution outcome blocks or marks reconciliation required. |
| Receiver-owned identity | Request payloads do not provide requester or approver identity; contexts come from explicit receiver-side runtime options or resolver. |
| Single durability authority | Case, decision, and execution events use the existing Graph mutation journal through the existing runtime. No new table, signer, or receipt family is introduced. |
| Existing approval compatibility | Existing `huqan.approve` default-decision, idempotency, CLI, rejection, and canonical approval receipt contracts remain covered by regression tests. |

## Verification

The targeted regression set passed with **45/45 tests**, covering the new MCP production-shaped path, the Human Oversight Runtime, MCP approval persistence, CLI approval workflow, MCP learn and ingest contracts, Agent Identity Runtime, and Trust Evidence Ledger.

The repository’s known `agent-context` test remains a remote-baseline synchronization exception and is not claimed as a product regression result for this slice. Global wiring across every MCP/HTTP/workflow ingress is intentionally not claimed; this closeout covers the opt-in MCP approval ingress only.

## Changed surfaces

- `mcpServer.js`
- `lib/mcp-approval-store.js`
- `lib/mcp-human-oversight-adapter.js`
- `package.json`
- `test/mcp-human-oversight-production-wiring.test.js`

## References

[1]: https://github.com/ali-ulu/huqan/commit/10bb023 "Huqan #942 MCP Human Oversight production wiring implementation"
[2]: https://github.com/ali-ulu/huqan/issues/942 "Huqan issue #942"
