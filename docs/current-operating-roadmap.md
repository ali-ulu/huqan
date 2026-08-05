# Current Operating Roadmap

**Live baseline:** `main` at
`5ca853261ae92db27535b6c3b8b1dfa7f31f1e99` (PR #262 V4-WB2 product
server-wiring implementation merge).

Live source, exact Git SHA, tests and CI outrank this compact execution source.
Detailed history remains in merged PRs, task-packs and audit evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, approvals, audit, signed package admission, canonical
receipts and bounded external-client trust/replay/mutation/transport owners.

The External Client Enablement-0 evidence program is closed, but its HTTP
adapter remains production-unreachable. V4 Workbench runtime-evidence work is
active.

V4-B1 read-only inspector runtime evidence is now closed:

- the Trust Receipt Inspector has an authenticated product route and no-mock
  real-server evidence;
- the Memory Admission / Context Integrity Inspector has a durable source
  contract, internal read-only adapter, bounded route contract, authenticated
  server registration, package reachability and real SQLite/HTTP smoke.

Workbench action/approval, receipt-export user flow and final V4 closeout are
not complete.

## Reconciled sequence

| Merged PR(s) | Closed boundary | Deliberate limit |
| --- | --- | --- |
| #132-#246 | Trust-boundary, receipt-root and bounded external-client evidence | No production external-client route |
| #247-#250 | WB2 durable-source authorization, proof and reconciliation | Source sufficient; no adapter or route |
| #251-#255 | WB2 adapter authorization, implementation and reconciliation | Internal read-only adapter; no route |
| #256-#259 | WB2 pure route contract and reconciliation | Helper merged; route unreachable |
| #260 / #261 | WB2 server-wiring authorization and reconciliation | Exact four-file runtime gate |
| #262 | WB2 server wiring, package reachability and no-mock product smoke | Read-only B1 evidence only; no action/approval |

## Closed WB2 durable-source and adapter evidence

PR #249 proved:

```text
V4_WB2_RUNTIME_SOURCE_SUFFICIENT
```

Exact reviewed head `59942569d327249d9319e9228f79be17feeb80ae`
passed Security Checks run `31022647956`, Benchmark Regression run
`31022647907` and full `npm test` job `92363082880`. It used real `Kernel`,
SQLite-backed `Graph`, real learn admission and close/reopen evidence.

PR #254 then implemented exactly:

```text
lib/workbench/memory-context-audit-source.js
test/v4-wb2-memory-context-audit-source.test.js
```

Its exact reviewed head `d662f6e545e5be12d5f7937d45599f1f6c33c989`
passed Security Checks run `31025724234`, Benchmark Regression run
`31025724138` and full `npm test` job `92373576698`.

The adapter requires exact `auditId` plus workspace, enforces a maximum
`1024`-record scan, fails closed on malformed, duplicate and over-bound reads,
maps only source-backed fields, leaves `traceId` null and exposes no mutation,
approval or action method.

## Closed WB2 pure route contract

PR #258 implemented exactly:

```text
lib/workbench/memory-context-route.js
test/v4-wb2c-memory-context-route-contract.test.js
```

Exact reviewed head `0156f0e0714dcf27c367a08d57a2cd4d38d18906`
passed Security Checks run `31027924345`, Benchmark Regression run
`31027925257` and full `npm test` job `92381072592`.

The helper validates exact audit and workspace identity, rejects malformed or
oversized values without truncation, delegates through the audit adapter and
inspector, and maps bounded `200/400/404/502` responses.

PR #259 reconciled that helper as live main
`d4055983ebe1ce3dfda45ae5f0342908e6d07835`.

## Closed WB2 product server wiring

PR #260 authorized and PR #261 reconciled the four-file server-wiring gate.
PR #262 implemented exactly:

```text
lib/workbench/workbench-read-http-router.js
server.js
package.json
test/v4-wb2d-memory-context-route-smoke.test.js
```

Exact reviewed head:

```text
fb77b175cf3a44d05ca0cc13b9f172c9ea1d241b
```

Exact-head evidence:

- Security Checks run `31031154969`: `SUCCESS`
- Benchmark Regression run `31031154766`: `SUCCESS`
- full `npm test` job `92391978739`: `SUCCESS`
- exact four-file scope, five commits ahead and zero behind
- 114-line bounded Workbench read router
- `server.js` changed by `+14/-35`, net `-21` lines
- exactly three package allowlist additions
- 239-line real SQLite/HTTP smoke owner
- zero unresolved review threads

PR #262 merged as live main:

```text
5ca853261ae92db27535b6c3b8b1dfa7f31f1e99
```

The merged boundary:

- moves the existing inline WB3 route into one bounded read-router seam without
  redesigning its response contract;
- registers only
  `GET /api/workbench/memory-context/:auditId?workspaceId=:workspaceId`;
- requires exactly one raw workspace query identity with no default,
  sanitizing, truncating or alternate-ID fallback;
- preserves outer rate limiting and API-key rejection before Graph reads;
- applies `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` to
  WB2 success and error responses, including the outer `429` path;
- preserves WB3 `no-cache` behavior and the original receipt route;
- publishes only the WB2 audit source, pure route and HTTP router required by
  installed server imports; and
- proves real review, approved, unauthenticated, method, malformed, oversized,
  unknown, cross-workspace, over-bound read-error, read-only, WB3 and legacy
  receipt scenarios through real `server.js`, real `Kernel`, SQLite-backed
  `Graph` and loopback HTTP.

No lockfile, dependency, request guard, Graph, Kernel, MemoryStore, inspector,
adapter, MCP, CLI, UI, release or deployment surface changed.

## Current gate

This reconciliation opens only:

```text
V4_B2_ACTION_APPROVAL_AUTHORIZATION
```

The next task must start from the exact post-reconciliation canonical `main`
and authorize one bounded V4-B2 Workbench action/approval slice. The
authorization itself is docs-only and may not implement runtime behavior.

Before selecting a seam, it must inspect current source owners for:

- action requests and action-risk classification;
- approval records, canonical approval states and expiry/lease semantics;
- existing fail-closed gate behavior;
- mutation ownership and unauthorized-mutation prevention;
- reviewed/blocked action receipts; and
- audit event ownership.

The authorization must define:

1. one exact user-visible or product-runtime action boundary;
2. one canonical approval owner rather than a parallel approval model;
3. exact missing, rejected, expired and unknown-outcome failures;
4. authorization and workspace authority order;
5. mutation timing and proof that no mutation occurs before valid approval;
6. receipt and audit evidence for allow, review, block and failure paths;
7. exact production and test file scope;
8. behavior-lock, targeted, full-regression and no-mock acceptance commands;
9. line budgets and touched-area modularization for oversized files; and
10. a separate post-merge reconciliation step.

The authorization may not combine V4-B3 receipt inspection/export user-flow or
V4-B5 closeout work.

## Remaining execution order

1. Authorize, implement, review, merge and reconcile one bounded V4-B2
   action/approval surface.
2. Prove V4-B3 receipt inspection/export through a real user flow.
3. Complete V4-B5 source/test/CI/package/release closeout.
4. Begin V5 successors only after V4 closeout and external interoperability
   entry gates.

## Permanent ordering rules

- One active task and exact post-merge main ancestry.
- Every implementation requires prior narrow authorization and later
  reconciliation.
- Approval state must come from an existing canonical durable owner.
- Missing, rejected, expired and unknown approval outcomes fail closed.
- No mutation occurs before exact action scope and approval are valid.
- Unknown outcomes are not automatically retried or compensated.
- Identity and workspace authority remain pre-bound and explicit.
- Missing context or provenance is never reconstructed.
- Historical V1 receipt bytes/hashes are never rewritten.
- V4 and V5 completion claims remain forbidden before their gates.

## Explicit non-goals

- No production external-client route.
- No action or approval implementation in the authorization/reconciliation PR.
- No new approval database, queue, persistence model, schema, migration or
  dependency without a separately proven source gap and product decision.
- No default workspace or caller-controlled approval authority.
- No retry, repair, compensation, release or deployment change.
- No V4-complete or V5-complete claim.

## Operating discipline

Clone-based agents read `AGENTS.md`, `docs/agent-canon.md`, the mutable
checkpoint and run `node scripts/agent-context.js`. Connector-only work records
local bootstrap, package dry-run and Graphify as unverified. Every delivery
carries exact base/head, scope, tests, CI, review, merge identity, non-claims
and the next-agent envelope.
