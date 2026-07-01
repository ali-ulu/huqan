# HUQAN / AXIOM - V4-PR3 Trust Receipt Read Surface Task-Pack

**Mode:** task-pack only.
**Implementation status:** not authorized yet.
**Canonical base:** `claude/practical-knuth-0ecsze`
**Required base HEAD:** `16069980f9db9f70c3f0d7396347cbd8000703b7`
**Current verdict:** `V4_PR2_5_MERGED_BASELINE_GREEN`

This document narrows V4-PR3 before any implementation work starts.

PR3 is a read surface over the real Trust Receipt primitive produced by PR2 and PR2.5.
It is not a viewer, Workbench, UI, demo pack, or productization sprint.

---

## Required Previous Merges

PR3 depends on the following canonical history:

| PR | Scope | Status |
|---|---|---|
| `#145` | V4 plan + big-file refactor gate | merged |
| `#146` | V4-PR0/PR1 trust runtime contract | merged |
| `#147` | V4-PR2 unified verdict reconciliation | merged |
| `#148` | V4-PR2.5 Trust Receipt primitive hardening | merged |

The current prerequisite state is:

```txt
V4_PR2_5_MERGED_BASELINE_GREEN
```

---

## Goal

Define V4-PR3 as a narrow Trust Receipt v1 read surface.

The PR3 implementation, when separately authorized, should expose existing real receipt data in a read-only way.

Core rule:

```txt
Read only.
No mutation.
No fake data.
No UI.
```

---

## Surface Order

PR3 should be planned in this order:

1. API read endpoint
2. CLI read command
3. Minimal local viewer later, in a separate PR, only after API + CLI are green

This task-pack authorizes only planning for API + CLI read surface.
Implementation requires separate explicit approval.

---

## Required Receipt Fields

The read surface should expose real fields when they exist:

```txt
receiptId
receiptHash
previousReceiptHash
actor
agentId
workspaceId
action / targetType / targetId
verdict
riskLevel / riskScore
evidence
provenance
policyId / trustPolicyVersion
approvalStatus
timestamp / createdAt
chainStatus
exportStatus
related receipts if available
```

If a field is not backed by real receipt data:

```txt
omit it
or return null with explicit status
```

Forbidden:

```txt
Never fabricate.
Never hardcode "verified".
Never invent receipt rows.
```

---

## Authorized Files - Planning Phase

Only this file is authorized in the PR3 planning branch:

```txt
docs/v4/v4-pr3-trust-receipt-read-surface.md
```

No runtime code, tests, package metadata, UI, or demo artifacts are authorized by this planning task-pack.

---

## Candidate Files - Future Implementation Only

These files are allowed only if PR3 implementation receives separate explicit approval:

```txt
server.js
or an existing route module if the repo already has route structure

cli.js
or an existing CLI command module if the repo already has command structure

lib/receipt/receipt-read-surface.js
test/v4-trust-receipt-read-surface.test.js
```

This document does not authorize touching those files.

---

## Forbidden Files And Scopes

Do not touch:

```txt
public/index.html
Workbench files
UI/viewer components
mcpServer.js
lib/memory-store.js
lib/receipt/*.js
package.json
package-lock.json
V5 / marketplace
demo files
tests
```

Do not start:

```txt
runtime implementation
API endpoint implementation
CLI command implementation
viewer/UI/surface
Workbench
V5
marketplace
```

---

## API Read Endpoint - Target Draft

Future implementation may expose:

```txt
GET /v4/receipts/:receiptId
GET /v4/receipts/:receiptId/chain
GET /v4/receipts/export?workspaceId=...
```

Rules:

```txt
Read-only.
No receipt creation.
No approval mutation.
No memory mutation.
No graph mutation.
Unknown receipt -> 404 / not_found.
Invalid receipt chain -> explicit invalid chainStatus.
Export must use the PR2.5 export primitive.
```

---

## CLI Read Command - Target Draft

Future implementation may expose:

```txt
huqan receipt show <receiptId>
huqan receipt chain <receiptId>
huqan receipt export --workspace <workspaceId>
```

Rules:

```txt
No mutation.
No fake sample receipt unless explicitly --demo and visibly labeled.
Default output must come from real receipt storage/export path.
```

---

## Implementation Test Plan - If Separately Approved

If implementation is later authorized, the minimum test plan is:

1. API show receipt:
   - a real receipt produced by the admission path is returned with real fields.
2. API unknown receipt:
   - unknown receipt returns `not_found`, not a fake empty receipt.
3. API chain:
   - valid chain returns `chainStatus=valid`.
4. API tampered chain:
   - tampered receipt returns `chainStatus=invalid`.
5. API export:
   - exported bundle verifies independently.
6. CLI show:
   - CLI displays the same receipt fields as the API/read module.
7. CLI chain:
   - CLI reports valid/invalid chain correctly.
8. No mutation:
   - API/CLI read commands do not create receipts, mutate memory, or alter approval state.
9. No hardcoded verified:
   - `chainStatus` and `exportStatus` must come from PR2.5 functions.
10. Full suite:
   - `npm test` must finish with 0 fail.

---

## Stop Conditions

Stop and report if any of these are true:

```txt
receipt storage/read path is not available
implementation would require inventing fake receipt persistence
server.js requires broad refactor
CLI integration requires changing unrelated command behavior
package files need changes
UI/viewer work appears
any receipt field must be fabricated
```

---

## Non-Claims

This task-pack does not claim:

```txt
production-grade ledger
enterprise audit certification
full connector coverage
full V4 Workbench
legal/compliance final judgment
immutable blockchain-like ledger
```

Safe claim:

```txt
HUQAN exposes a read-only Trust Receipt surface backed by the real PR2.5 receipt primitive.
```

---

## Final Verdict

```txt
V4_PR3_TASK_PACK_READY

Implementation:
NOT_AUTHORIZED_YET

Next authorized action:
Review this docs-only task-pack.
```
