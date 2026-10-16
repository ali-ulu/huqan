# HUQAN / AXIOM V4-WB3 Trust Receipt Inspector Read Surface Scope

**Mode:** docs-only product and security contract.
**Canonical source base:** `main @ 8b90fe6f57b9d05a9767e17ad6a06fce56c90418`
**Decision:** expose WB1's existing read-only helper through the canonical
authenticated API, not a new store or a new auth boundary.
**Implementation status:** not authorized by this document.

## Goal

Close TB-produced gap `V4-B1 — Prove read-only Workbench inspectors in
product runtime`, narrowly for the Trust Receipt Inspector only. Define the
smallest route that lets an operator call the already-implemented
`lib/workbench/trust-receipt-inspector.js` helper against real runtime state,
so the inspector's fail-closed contract can be proven with a no-mock smoke
instead of unit tests alone.

This document does not authorize the Memory Context Inspector (WB2). WB2 has
no durable, recordId-queryable store in production (`memoryAdmission` exists
only transiently inside an MCP `learn` tool response — see
`lib/mcp/response-builders.js`). Routing WB2 through HTTP would require
inventing persistence that does not exist today; that is a separate product
decision and out of scope here.

## Source Reality

The canonical materialized receipt read route already exists and is
protected:

```text
GET /api/trust-receipt/:receiptId?workspaceId=<optional>
```

It is guarded by `denyIfUnauthorized()` (Bearer or `X-API-Key`) and reads via
`readReceiptById(cli.kernel.graph, receiptId, filters)` (`server.js:1013-1051`).

`lib/workbench/trust-receipt-inspector.js` (`inspectTrustReceipt`) already
wraps a `readReceipt`-shaped source and normalizes it into WB1's terminal
states (`found`, `not_found`, `invalid_request`, `read_error`). It is not
called anywhere in `server.js` today — there is no product runtime wiring,
which is exactly the WB1 evidence gap V4-B1 records.

No new receipt model, chain-status computation, or field is required: the
inspector already consumes the same `readReceiptById` contract the existing
route uses.

## Selected Boundary

Add exactly one authenticated, read-only route that delegates to the
existing helper and the existing graph read path. No new auth mechanism, no
session gateway, no new storage.

```text
GET /api/workbench/trust-receipt/:receiptId?workspaceId=<optional>
```

- protected by the same `denyIfUnauthorized()` used by
  `/api/trust-receipt/:receiptId`;
- delegates to `inspectTrustReceipt({ receiptId, workspaceId, source: cli.kernel.graph })`;
- returns the inspector's own terminal-state shape (`ok`, `status`,
  `receiptId`, `verdict`, `reason`, `missingFields`, `chainStatus`, `source`)
  as the JSON body, unmodified by the route handler;
- `Cache-Control: no-cache` on every response, matching the existing receipt
  route.

The route must not:

- accept a request body or any field that selects workspace, actor, or
  identity beyond the existing `receiptId` path segment and optional
  `workspaceId` query parameter;
- create, mutate, or replay a receipt, journal entry, or approval;
- call the Memory Context Inspector or expose a `recordId`-based path;
- change `/api/trust-receipt/:receiptId` behavior;
- weaken or duplicate `denyIfUnauthorized`.

## Response Terminal States

Only states the inspector already returns are valid HTTP outcomes:

```text
found            -> 200, inspector payload
not_found        -> 404
invalid_request  -> 400
read_error       -> 502
unauthorized     -> 401 (via denyIfUnauthorized, before the inspector runs)
```

No state may synthesize a receipt field, verdict, or chain status not
produced by `inspectTrustReceipt`.

## Required Test Ownership

The implementation gate must add targeted tests for:

- a real receipt created through the existing runtime path is readable by
  the new route with an identical `receiptId`;
- an unknown `receiptId` returns `not_found` / `404` with no fabricated
  fields;
- a missing or malformed `receiptId` returns `invalid_request` / `400`;
- an unauthenticated request returns `401` before the inspector is invoked;
- workspace-scoped filtering matches the existing `/api/trust-receipt`
  route's behavior;
- the route does not mutate graph, receipt, journal, or audit state
  (before/after snapshot equality);
- a no-mock smoke: start the real `server.js`, issue a real HTTP request
  against the new route, and assert on the live response — no injected
  fixtures standing in for the HTTP layer.

## Gate Sequence

```text
V4_WB3_TRUST_RECEIPT_READ_SURFACE_SCOPE
-> V4_WB3A_ROUTE_CONTRACT_TESTS
-> V4_WB3B_ROUTE_IMPLEMENTATION
-> V4_WB3C_NO_MOCK_RUNTIME_SMOKE
-> V4_B1_CLOSEOUT (Trust Receipt Inspector only)
```

WB2 (Memory Context Inspector) remains open under V4-B1 pending a separate
scope document that first decides whether/how memory-admission evidence is
persisted for later lookup.

## Stop Conditions

Stop and open a separate product decision if:

- the route needs to expose any field `inspectTrustReceipt` does not already
  produce;
- a `recordId`-addressable memory-admission store is requested (that is
  WB2, not WB3);
- cross-workspace or unauthenticated access is required;
- the route needs write, approval, retry, or replay behavior of any kind.

## Forbidden Scope

This gate does not authorize:

- Memory Context Inspector (WB2) routing or persistence;
- any change to `denyIfUnauthorized`, session handling, or CORS;
- a new receipt model, receipt API, or chain-validation algorithm;
- V4-B2/B3/B5, V5, connector, or deployment work;
- a V4-Workbench-complete or production-ready claim.

## Verdict

```text
V4_WB3_TRUST_RECEIPT_READ_SURFACE_SCOPE_DEFINED
V4_WB3A_NOT_AUTHORIZED
```
