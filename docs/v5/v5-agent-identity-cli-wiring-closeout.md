# Runtime Agent Identity — CLI approval wiring closeout

**Issue:** #940  
**Status:** production-shaped, explicit opt-in slice  
**Durability:** existing Graph mutation journal and receipt path  
**Fail-closed:** enabled

## Scope

The CLI `onayla` path now propagates explicit `agentIdentityRuntime` and Human Oversight options into the existing MCP approval lifecycle. When enabled, receiver-owned identity is evaluated before approval claim and execution. A refusal leaves the approval pending, prevents executor invocation, and returns the bounded `IDENTITY_ENFORCEMENT_BLOCKED` error surface. Callers without the opt-in options retain legacy behavior.

## Security boundaries

The implementation reuses the existing approval store, Human Oversight runtime, Graph mutation journal, Trust Evidence Ledger and receipt chain. It adds no second identity store, signer, receipt family, SQLite table or durability authority. CLI responses expose only bounded identity/oversight projections; raw claims, tokens and unrestricted requester context are not copied into the response.

The CLI awaits the oversight-enabled Promise path before formatting output. Bounded refusal metadata preserves the underlying error code and does not claim success. The SQLite mutation-journal prefix read uses the corrected single-character SQL `ESCAPE` clause so durable oversight cases can be read through the existing Graph authority.

## Verification

The focused CLI/identity/oversight checkpoint passed **44/44 tests**, including valid receiver identity, receiver mismatch, no executor on refusal, pending approval state, bounded response metadata, async approval completion, MCP and HTTP oversight wiring, Agent Identity runtime, Trust Evidence Ledger and CLI workflow behavior. `git diff --check` passed.

## Non-claims

This closeout covers only the CLI approval-decision path that delegates to the existing MCP approval lifecycle. It does not claim identity enforcement for every CLI command, generic CLI mutation execution, connector IAM authorization, external credential issuance, universal identity-provider integration, encryption, or secret-management replacement.

## Files

- `cli.js`
- `lib/cli-workflow-adapter.js`
- `lib/mcp-approval-views.js`
- `lib/mutation-journal.js`
- `test/cli-agent-identity-oversight-production-wiring.test.js`

This is a technical closeout, not a product or regulatory determination.

**Source commit:** `0d8fdfd` — `feat(#940 #942): wire identity and oversight into CLI approvals`

**Issue comments:** to be added to #940 and #942 after the documentation commit.

*End of closeout.*
