# V3 Core Smoke Checklist

## V3 Core Components

- Approval Request Schema
- Pending Approval Queue
- Approval Decision Flow
- Reviewed / Blocked Action Receipts
- Memory Admission Gate
- Admission Receipts
- Local-first Audit Integration

## Smoke Matrix

1. Build approval request -> status `pending`
2. Enqueue approval request -> list/get works
3. Approve request -> reviewed action receipt
4. Reject request -> blocked action receipt
5. Memory admission `allow` -> admission receipt
6. Memory admission `review` -> review decision
7. Memory admission `reject` -> rejection receipt
8. Memory admission `quarantine` -> quarantine-compatible receipt
9. Rejected memory does not become canonical
10. No helper mutates input objects
11. Existing status contracts remain unchanged
12. Existing MCP tests, if present, still pass

## Non-goals

- No new product feature
- No server endpoint changes
- No MCP live certification claim
- No UI rewrite
- No package version bump
- No release tag
- No hidden memory writes
- No V4/V5 work

## MCP Live Integration Status

Live Codex MCP integration is currently pending reinstall.
This checklist records the V3 Core smoke boundary, not MCP certification.

## Clean-Main Smoke Expectations

- `npm ci` succeeds in a clean clone
- `npm test` passes
- Server endpoints respond:
  - `/health`
  - `/v2-status`
  - `/graph-data`

