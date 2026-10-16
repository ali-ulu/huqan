# P0-A — A2A production transport scope freeze

## Purpose

This docs-only gate freezes the scope of the first P0 unit: giving the existing
bounded A2A exchange evaluation a **production entry point**, so that A2A stops
being a development harness and becomes a reachable server surface.

It authorizes no code. It exists because the entry decision that used to block
this work has been superseded, and the next agent needs a bounded scope rather
than an open-ended "build A2A" instruction.

## Canonical base

```text
repository: ali-ulu/huqan
branch: main
required base: dff2ce94a4189403e0b2834ed48b7b1721dc4db4
package: 0.9.1
```

Predecessor gates, both merged:

- `docs/v5/v5-implementation-entry-successor-audit.md` (PR `#832`) records
  `V5_IMPLEMENTATION_ENTRY: PASS`.
- PR `#833` removed the superseded entry-decision reason from
  `lib/module-reachability.js`.

A successor must verify its own exact `main` SHA rather than trusting this one.

## Source reality

Established by reading live source at the base above, not from roadmap prose.

### What already exists

| Surface | Location | State |
|---|---|---|
| Bounded A2A exchange evaluator | `scripts/a2a-conformance/verifier.js` (652 lines), exporting `evaluateBoundedExchange`, `canonicalHash`, `signingView`, `envelopeCoreView`, `delegationSigningView` | works; dev-harness location |
| Harness driver and child consumer | `scripts/a2a-conformance/{run.js,consumer.js,replay-store.js}`, `npm run conformance:a2a` | works |
| Exchange semantics of record | `docs/v5/v5-d6-bounded-a2a-exchange.md` | `implementation` |
| Wire schema | `specs/huqan-trust-protocol/0.2/schemas/a2a-trust-evidence.schema.json`, `schemas/v5/a2a-trust-evidence.schema.json` | present |
| Negative fixtures | `test/fixtures/v5/a2a-trust-evidence/` — scope-exceeded, missing-evidence, expired-delegation, broken-delegation-chain, requested-vs-observed mismatch, unknown-outcome, falsification | present |
| HTTP auth policy | `lib/http/route-auth-policy.js` | production |
| HTTP routers and envelope helpers | `lib/http/*.js` | production |
| Signature verification, allowlist and replay rejection for an external caller | `lib/external-client-authority.js`, `lib/external-client-replay-store.js`, `lib/external-client-package-gate.js` | production, reached via `/api/external-client/packages/admit` |
| Exact-workspace enforcement | `lib/http/exact-workspace.js` | production |

### What does not exist

Verified absent at the base — no file in the repository matches:

- an Agent Card document or a `.well-known` route of any kind;
- a JSON-RPC framing layer;
- an SSE endpoint;
- an A2A HTTP route;
- capability negotiation;
- a task lifecycle store, task IDs, or idempotency keys for A2A;
- cancellation.

So P0's evaluation semantics are **already built and tested**, and P0's
transport is genuinely greenfield.

### The reachability consequence

`scripts/a2a-conformance/verifier.js` requires four modules that are still
listed in `lib/module-reachability.js::NOT_YET_WIRED`:

```text
lib/v5/cryptographic-profile-contract.js
lib/v5/cryptographic-verification-adapter.js
lib/v5/public-trust-receipt.js
lib/v5/trusted-key-resolver.js
```

`scripts/` is a `STANDALONE_PREFIXES` entry, so requiring them from there does
not make them reachable. A production caller does. This means the first honest
P0 unit necessarily moves the evaluator out of `scripts/` and into `lib/`, and
that move is what graduates those four modules off the acknowledgement list.

That is a consequence to be recorded in the implementing PR, not a goal to be
pursued for its own sake. No module may be moved solely to shorten the list.

## Governing invariants

1. Exchange semantics are **reused, not reimplemented**. A second evaluator is
   a defect, not a feature.
2. The evaluator moves location without changing behavior. Its current outputs
   for every existing fixture must be identical before and after.
3. `npm run conformance:a2a` keeps passing against the moved evaluator, and
   keeps being the semantic regression owner.
4. Receiver-owned authority stays receiver-owned: identity, trusted keys,
   package allowlist, target binding and evaluation clock never come from the
   request body. `docs/v5/v5-d6-bounded-a2a-exchange.md` is binding here.
5. Fail-closed is preserved. An unverifiable exchange is rejected; it is never
   downgraded to a warning.
6. Auth goes through `lib/http/route-auth-policy.js`. No route invents its own
   auth, and no A2A route is public.
7. Canonical workspace `default` only, via the existing exact-workspace helper.
   P0 does not introduce multi-tenant authority.
8. `ARCH-001` holds: `server.js` gains wiring and delegation only. Exchange
   logic lives in its own single-responsibility module.
9. No file crosses the 800-line threshold in `scripts/check-file-size.js`, and
   the baseline ledger is not widened.
10. Replay rejection reuses the existing external-client replay owner rather
    than a second store.

## Scope of P0-A's successor (P0-B)

P0-B is the first implementation unit. It may add exactly one authenticated
route and the module behind it:

```text
POST /api/a2a/exchange
```

Its required behavior:

- authenticated through the existing route-auth policy;
- canonical workspace `default` only;
- request body is a bounded A2A exchange envelope, size-capped;
- evaluation delegates to the relocated `evaluateBoundedExchange`;
- a verified exchange returns its evaluation result;
- an unverified exchange returns a fail-closed rejection with a bounded reason
  code and no partial acceptance;
- a replayed exchange is rejected through the existing replay owner;
- every existing negative fixture in `test/fixtures/v5/a2a-trust-evidence/` has
  a route-level test asserting rejection.

P0-B may change only:

```text
server.js                      (wiring and delegation only)
lib/http/route-auth-policy.js  (one route rule)
lib/a2a/exchange-route.js      (new)
lib/a2a/bounded-exchange.js    (relocated evaluator)
scripts/a2a-conformance/verifier.js  (becomes a re-export shim, or is deleted
                                      if run.js is repointed in the same change)
lib/module-reachability.js     (only the entries the move actually graduates)
test/a2a-exchange-route.test.js (new)
```

If the relocation cannot preserve identical evaluator behavior inside those
files, stop with:

```text
P0B_BLOCKED_BY_EVALUATOR_RELOCATION
```

## Deferred to later P0 units

These are named so they are not silently smuggled into P0-B, and not forgotten:

| Unit | Surface |
|---|---|
| P0-C | Agent Card document and its discovery route |
| P0-D | capability negotiation |
| P0-E | task lifecycle, task IDs, idempotency keys |
| P0-F | cancellation, timeout and retry semantics |
| P0-G | transport framing choice — JSON-RPC or HTTP+SSE — with its own contract |

P0-B deliberately uses plain authenticated HTTP+JSON. A framing layer is
YAGNI until a second surface needs it; choosing JSON-RPC or SSE before there is
a caller is a decision made without evidence.

## Forbidden scope

P0-A changes no file other than this one. P0-B must not:

- write a second exchange evaluator;
- change any evaluation rule, threshold, bound, or reason code;
- add an Agent Card, discovery route, capability negotiation, task store,
  idempotency key, cancellation, JSON-RPC framing or SSE;
- accept identity, trusted keys, package allowlist, target binding or clock
  from the request body;
- expose a generic Graph, Kernel or verification adapter over HTTP;
- introduce non-default workspace authority;
- touch approval, receipt or package wire formats;
- remove a `NOT_YET_WIRED` entry that its own change does not actually reach;
- claim third-party interoperability or external conformance.

## Acceptance criteria for P0-A

1. Exactly one new file changes.
2. The canonical base is exact.
3. Existing A2A surfaces are inventoried from live source.
4. Absent surfaces are stated as absent rather than assumed.
5. The reachability consequence is recorded as a consequence, not a goal.
6. P0-B's file list and route are explicit and bounded.
7. Later P0 units are named and deferred.
8. `git diff --check` passes and the worktree is clean after commit.

## Validation

```bash
git diff --name-only origin/main...HEAD   # exactly this file
git diff --check
npm run conformance:a2a
node --test test/module-reachability.test.js
```

No runtime test is required for this docs-only gate. Previous suite totals must
not be reported as new-head evidence.

## Stop conditions

Stop and report instead of widening scope if:

- canonical `main` differs from the required base;
- `evaluateBoundedExchange` turns out to have callers this document missed;
- the relocation would require changing evaluator behavior;
- an existing negative fixture cannot be exercised at route level;
- `npm run conformance:a2a` is not green at the head under review.

## Non-claims

This document does not claim that:

- an A2A transport, Agent Card, discovery surface, capability negotiation, task
  lifecycle or cancellation exists;
- P0-B is complete, started, or authorized to exceed the file list above;
- the relocated evaluator has a production caller yet;
- external agents can interoperate with this repository;
- any third party has verified anything.
