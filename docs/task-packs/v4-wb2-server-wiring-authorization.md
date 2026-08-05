# V4-WB2 Server Wiring Authorization

## Authorization identity

- Repository: `ali-ulu/huqan`
- Exact authorization base: `main @ d4055983ebe1ce3dfda45ae5f0342908e6d07835`
- Package version: `0.9.1`
- Active gate: `V4_WB2D_SERVER_WIRING_AUTHORIZATION`
- Authorized successor: `V4_WB2D_SERVER_WIRING_IMPLEMENTATION`
- This document authorizes one bounded Workbench read-router seam, minimal
  server composition, package reachability and one no-mock WB2 smoke owner.

## Source-backed decision

The pure WB2 route contract is merged but unreachable. `server.js` already
contains the WB3 Workbench receipt route as an inline block and is an oversized
production file. Adding a second inline Workbench domain block would increase
technical debt and violate touched-area modularization.

The implementation must therefore extract the existing WB3 read-route block
into one narrow Workbench HTTP router and add WB2 there. `server.js` retains
only composition and outer transport guards.

Existing WB3 behavior is a behavior lock. It must remain byte/shape compatible
for status, body, authentication ordering and `Cache-Control: no-cache`.

## Exact implementation scope

The successor may change exactly:

```text
lib/workbench/workbench-read-http-router.js
server.js
package.json
test/v4-wb2d-memory-context-route-smoke.test.js
```

No lockfile change is authorized because no dependency changes.

Line budgets:

- new production router: at most `250` lines;
- new smoke owner: at most `300` lines where practical;
- `server.js`: net line growth must be non-positive by replacing the existing
  WB3 inline block with one router call;
- no unrelated formatting or cleanup.

## Required Workbench read-router seam

`lib/workbench/workbench-read-http-router.js` must export exactly:

```text
createWorkbenchReadHttpRouter
```

The factory may import only existing Workbench route contracts:

```text
lib/workbench/trust-receipt-route.js
lib/workbench/memory-context-route.js
```

Transport-local helpers must be injected rather than copied:

```text
writeJson
writeApiError
denyIfUnauthorized
readTrustFilters
readReceiptById
```

The returned function accepts only the request, response, parsed URL and Graph
owner needed to handle Workbench reads. It returns `true` when it handled a
matched path and `false` otherwise.

It must expose no mutation, approval, action, retry or repair operation.

## Existing WB3 preservation

The router must move, not redesign, the existing
`/api/workbench/trust-receipt/:receiptId` block.

Preserve:

- `GET` only;
- existing `405` body and code;
- API-key rejection before receipt lookup;
- existing path parser and route helper;
- current optional workspace filter behavior;
- current `200/400/404/502` semantics;
- `Cache-Control: no-cache`;
- CORS and JSON response behavior through existing server helpers; and
- the original `/api/trust-receipt/:receiptId` route outside the new router.

Existing WB3 route-contract and no-mock server tests are mandatory targeted
regressions and may not be modified.

## WB2 route identity and ordering

Register only:

```text
GET /api/workbench/memory-context/:auditId?workspaceId=:workspaceId
```

The server order remains:

```text
viewer gateway
-> OPTIONS
-> outer rate limit
-> URL parsing
-> Workbench read router
-> route match
-> method gate
-> security headers
-> API-key gate
-> exact query/path validation
-> pure WB2 route helper
```

No POST, list, latest, search, batch, mutation, approval or action surface is
authorized.

## WB2 workspace authority

Do not use `readTrustFilters()` for WB2 workspace authority because it
sanitizes/truncates identifiers. WB2 must read the raw query values and require
exactly one `workspaceId` parameter.

Rules:

- zero values: pure helper returns `missing_workspace_id`;
- more than one value: return `400 invalid_workspace_id` before Graph read;
- one raw value is passed unchanged to the pure helper;
- 129+ characters are rejected, never truncated;
- no default workspace;
- no header/body/stored-record fallback; and
- no alternate audit identity.

## WB2 headers and response contract

As soon as the WB2 path matches, before method or authentication response,
set:

```text
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

All WB2 responses, including `401`, `405`, `400`, `404`, `429` inherited from
the outer guard where applicable, `502` and `200`, must not be cacheable.

Use existing `writeJson()` so JSON content type and safe-origin CORS behavior
remain canonical.

Method mismatch returns `405` with a bounded `method_not_allowed` error. Valid
requests delegate exactly:

```text
parseWorkbenchMemoryContextPath(pathname)
-> handleWorkbenchMemoryContextRequest({
     recordId,
     workspaceId,
     auditOwner: graph
   })
-> writeJson(statusCode, body)
```

No audit fields, receipts, provenance, source references or target text may be
added by the HTTP layer.

## Minimal server.js composition

`server.js` may:

1. replace direct WB3 route-contract imports with
   `createWorkbenchReadHttpRouter`;
2. create one router instance after the existing transport helper declarations;
3. replace the current inline WB3 block with one bounded call immediately after
   URL parsing/preceding trust-read routes as source order requires; and
4. return when the router reports a handled request.

No domain mapping, workspace fallback or response normalization may be added to
`server.js`.

The diff must remove at least as many server lines as it adds.

## Package reachability

`package.json` may add exactly these internal runtime files to `files`:

```text
lib/workbench/memory-context-audit-source.js
lib/workbench/memory-context-route.js
lib/workbench/workbench-read-http-router.js
```

No version, script, dependency, export map or lockfile change.

Existing installed-tarball tests in
`test/kernel-facade-contract.test.js` must prove `require('huqan/server')`
remains loadable from the packed install. The implementation must not edit that
test unless an independently authorized source conflict is found.

## Required no-mock smoke

`test/v4-wb2d-memory-context-route-smoke.test.js` must use real `server.js`,
real `Kernel`, real SQLite-backed `Graph` and real HTTP loopback.

Required scenarios:

1. real review-required admission read returns `200 review_required` after
   durable audit creation;
2. real approved admission edge audit returns `200 admitted` with canonical
   mutation flags and matching receipt ID;
3. unauthenticated request returns `401` before Graph read;
4. wrong method returns `405`;
5. missing, duplicate, blank, malformed and oversized workspace return `400`;
6. missing, malformed and oversized audit ID return `400`;
7. unknown ID and cross-workspace lookup return `404`;
8. a real workspace with more than `1024` audit rows yields `502 read_error`
   without mocks;
9. every WB2 response includes `Cache-Control: no-store` and
   `X-Content-Type-Options: nosniff`;
10. safe-origin CORS remains bounded;
11. before/after nodes, edges and audit rows are identical for reads;
12. existing WB3 Workbench receipt route remains functional; and
13. original `/api/trust-receipt/:receiptId` remains functional.

The smoke may use the existing CLI module-cache substitution pattern solely to
capture the real server-owned kernel. It may not replace Graph, adapter,
inspector, route helper or HTTP router behavior.

## Acceptance commands

```bash
node --test test/v4-wb2d-memory-context-route-smoke.test.js
node --test test/v4-wb2c-memory-context-route-contract.test.js
node --test test/v4-wb2-memory-context-audit-source.test.js
node --test test/v4-wb3c-trust-receipt-route-smoke.test.js
node --test test/kernel-facade-contract.test.js
npm test
npm pack --dry-run --json --ignore-scripts
graphify update .
git diff --check
git diff --name-only <exact-base>...HEAD
git status --short
```

Acceptance requires:

- exact four-file scope;
- no lockfile or dependency change;
- `server.js` net line growth non-positive;
- targeted and full tests exit `0` with zero failures;
- real SQLite/no-mock HTTP evidence;
- installed-tarball server load passes;
- package dry-run contains all three required internal files;
- Graphify has no unexplained unrelated drift;
- exact-head Security Checks and Benchmark Regression succeed;
- zero unresolved review threads; and
- no mutation caused by WB2 reads.

## Mandatory successor

After implementation merges:

```text
V4_WB2D_SERVER_WIRING_IMPLEMENTATION
-> V4_WB2D_SERVER_WIRING_RECONCILIATION
```

Only reconciliation may decide whether V4-B1 runtime evidence is closed and
which remaining V4 gate opens next.

## Forbidden scope

- no `requestGuards.js`, lockfile, Graph, Kernel, MemoryStore, adapter,
  inspector or pure route-contract modification;
- no new persistence, schema, table, index, migration or dependency;
- no external-client route registration;
- no MCP, CLI, UI, public asset or viewer change;
- no default workspace or caller-controlled trust authority;
- no full receipt or arbitrary audit-detail exposure;
- no retry, repair, approval transition or mutation;
- no package version, release or deployment change;
- no V4-complete or V5-complete claim.

## Stop conditions

Stop without widening scope if:

- existing WB3 behavior cannot be preserved through the seam;
- `server.js` net growth becomes positive;
- exact workspace authority requires sanitization or truncation;
- package reachability needs an export/dependency/lockfile change;
- no-mock positive paths require replacing runtime owners; or
- exact implementation scope cannot remain four files.

## Connector-only limits

During this docs-only authorization, local clone bootstrap,
`node scripts/agent-context.js`, local worktree state, local tests, package
dry-run, `git diff --check` and Graphify refresh were unavailable through the
connector environment. Exact source, Git ancestry, changed-file scope and
GitHub CI remain controlling evidence.

## Non-claims

This authorization does not claim that server wiring, package reachability,
no-mock WB2 runtime evidence, V4 closeout or V5 implementation is complete.
