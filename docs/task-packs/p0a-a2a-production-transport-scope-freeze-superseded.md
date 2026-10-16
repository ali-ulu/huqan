# P0-A — A2A production transport scope freeze (superseded)

Status: Superseded; phase closeout record. No implementation authorization.

## Supersession statement

This document is superseded by the live phase closeout recorded in PR `#855`
(`501fd3729cffd93069a3894a856ae5504a582dc6`). It remains in the tree for the
record of what P0-A authorized; everything below this section describes the
state at the canonical base and is now historical.

## Source reality (current `main`)

| Unit | Surface | Status | PR |
|---|---|---|---|
| P0-B | `POST /api/a2a/exchange` | merged `1af415272dcc911a6bf7b0ca349f4b6cba22ddcf` | #836 |
| P0-C | `GET /.well-known/agent-card.json` | merged | #850 |
| P0-D | `POST /api/a2a/negotiate` | merged | #852 |
| P0-E | `GET /api/a2a/tasks/{taskId}`, task ids on admission | merged | #853 |
| P0-F | `safeToRetry` on every refusal, enforced request deadline | merged | #854 |

Phase closeout verdict, merged:

```text
P0_A2A_PRODUCTION_TRANSPORT: SHIPPED_WITH_ONE_UNIT_DEFERRED
```

The deferred unit is P0-G (transport framing choice — JSON-RPC or HTTP+SSE).
It is deferred on YAGNI grounds: no second surface currently needs a framing
layer, and plain authenticated HTTP+JSON suffices for everything merged.
Shipping P0-G later requires a caller that demonstrates the need; it is a
decision with reasons in source, not a gap.

## Governing invariants carried into the closeout

1. `bounded-exchange.js` reserves the replay key **before** running the effect
   and leaves the marker standing if the effect throws. An exchange whose
   outcome is unknown is never retried and never guessed at.
2. `conformance:a2a` holds at 50/50 across the merged phase — the semantic
   regression owner for the moved evaluator.
3. Receiver-owned authority stayed receiver-owned throughout: identity, trusted
   keys, package allowlist, target binding and evaluation clock never come
   from the request body. `idempotency keys` and `cancellation` remain in the
   Agent Card's `unsupported` list and are asserted exactly.

## Validation (updated per the reviewing agent's correction, refs #845)

```bash
git diff --name-only origin/main...HEAD
git diff --check
npm run conformance:a2a
node --test test/module-reachability.test.js
node --test test/a2a-exchange-route.test.js
```

Static reachability and conformance alone do not prove the HTTP route
boundary. `node --test test/a2a-exchange-route.test.js` is the route-level
evidence and must be part of any P0 transport validation after P0-B.

## Non-claims

This supersession does not claim external agent interoperability, third-party
verification, or authorization of P0-G. `idempotency-keys` and `cancellation`
are recorded as deliberate unsupported decisions, not open defects.
