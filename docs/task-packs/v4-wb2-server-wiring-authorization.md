# V4-WB2 Server Wiring Authorization

## Authorization identity
- Repository: `ali-ulu/huqan`
- Exact authorization base: `main @ d4055983ebe1ce3dfda45ae5f0342908e6d07835`
- Package version: `0.9.1`
- Active gate: `V4_WB2D_SERVER_WIRING_AUTHORIZATION`
- Authorized successor: `V4_WB2D_SERVER_WIRING_IMPLEMENTATION`
- Scope: one bounded Workbench read-router seam, minimal server composition,
  package reachability and one no-mock WB2 smoke owner.

## Source-backed decision
The pure WB2 route contract is merged but unreachable. `server.js` already
contains the WB3 Workbench receipt route as an inline block and is oversized.
Adding a second inline domain block would increase technical debt.

The implementation must extract the existing WB3 block into one narrow
Workbench HTTP router and add WB2 there. `server.js` retains composition and
outer transport guards only. Existing WB3 behavior is the behavior lock and
must remain compatible for status, body, authentication order and cache policy.

## Exact implementation scope
The successor may change exactly:

```text
lib/workbench/workbench-read-http-router.js
server.js
package.json
test/v4-wb2d-memory-context-route-smoke.test.js
```

No lockfile change. Line budgets:
- new production router: at most `250` lines;
- new smoke owner: at most `300` lines where practical;
- `server.js`: net line growth non-positive by replacing the WB3 inline block;
- no unrelated formatting or cleanup.

## Workbench read-router seam
`lib/workbench/workbench-read-http-router.js` exports exactly:

```text
createWorkbenchReadHttpRouter
```

It may import only:

```text
lib/workbench/trust-receipt-route.js
lib/workbench/memory-context-route.js
```

Inject, do not copy, these server-local helpers:

```text
writeJson
writeApiError
denyIfUnauthorized
readTrustFilters
readReceiptById
```

The returned function accepts the request, response, parsed URL and Graph owner,
returns `true` for a handled Workbench path and `false` otherwise, and exposes
no mutation, approval, action, retry or repair operation.

## Existing WB3 preservation
Move, do not redesign, `/api/workbench/trust-receipt/:receiptId`.
Preserve:
- `GET` only and the existing `405` shape;
- API-key rejection before lookup;
- current parser, route helper and optional workspace filter;
- current `200/400/404/502` semantics;
- `Cache-Control: no-cache`;
- existing JSON/CORS behavior; and
- the original `/api/trust-receipt/:receiptId` outside the new router.

Existing WB3 contract and no-mock tests are mandatory regressions and may not be
modified.

## WB2 route and ordering
Register only:

```text
GET /api/workbench/memory-context/:auditId?workspaceId=:workspaceId
```

Preserve this order:

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
-> exact identity validation
-> pure WB2 route helper
```

No POST, list, latest, search, batch, mutation, approval or action surface.

## WB2 workspace authority
Do not use `readTrustFilters()` for WB2 because it sanitizes/truncates IDs.
Read raw query values and require exactly one `workspaceId`:
- zero values: pure helper returns `missing_workspace_id`;
- multiple values: `400 invalid_workspace_id` before Graph read;
- one value passes unchanged to the pure helper;
- 129+ characters reject without truncation;
- no default, header, body, stored-record or alternate-ID fallback.

## WB2 headers and delegation
When the WB2 path matches, before method/auth responses set:

```text
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

All WB2 responses must remain non-cacheable. Use existing `writeJson()` for
canonical JSON content type and safe-origin CORS. Method mismatch returns `405`
with bounded `method_not_allowed` data. Valid requests delegate exactly:

```text
parseWorkbenchMemoryContextPath(pathname)
-> handleWorkbenchMemoryContextRequest({
     recordId,
     workspaceId,
     auditOwner: graph
   })
-> writeJson(statusCode, body)
```

The HTTP layer adds no audit fields, receipt, provenance, source reference or
target text.

## Minimal server.js composition
`server.js` may only:
1. replace direct WB3 route imports with `createWorkbenchReadHttpRouter`;
2. create one router instance after existing transport helpers;
3. replace the inline WB3 block with one bounded router call; and
4. return when the router reports a handled request.

No domain mapping, workspace fallback or response normalization in `server.js`.
The diff removes at least as many server lines as it adds.

## Package reachability
`package.json` may add exactly:

```text
lib/workbench/memory-context-audit-source.js
lib/workbench/memory-context-route.js
lib/workbench/workbench-read-http-router.js
```

No version, script, dependency, export-map or lockfile change. Existing
installed-tarball tests in `test/kernel-facade-contract.test.js` must prove
`require('huqan/server')` loads from the packed install; do not edit that test
without a separately proven source conflict.

## Required no-mock smoke
`test/v4-wb2d-memory-context-route-smoke.test.js` uses real `server.js`, real
`Kernel`, real SQLite-backed `Graph` and real HTTP loopback. It must prove:
1. real review admission returns `200 review_required`;
2. real approved edge audit returns `200 admitted`, canonical flags and receipt;
3. unauthenticated request returns `401` before Graph read;
4. wrong method returns `405`;
5. missing, duplicate, blank, malformed and oversized workspace return `400`;
6. missing, malformed and oversized audit ID return `400`;
7. unknown and cross-workspace lookup return `404`;
8. more than `1024` real audit rows yield `502 read_error` without mocks;
9. every WB2 response has `no-store` and `nosniff`;
10. safe-origin CORS remains bounded;
11. nodes, edges and audit rows are unchanged by reads;
12. existing WB3 Workbench receipt route still works; and
13. original `/api/trust-receipt/:receiptId` still works.

The existing CLI module-cache substitution pattern may capture the real
server-owned kernel. Do not replace Graph, adapter, inspector, route helper or
HTTP router behavior.

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
- exact four-file scope and no lockfile/dependency change;
- non-positive `server.js` net growth;
- targeted/full tests exit `0` with zero failures;
- real SQLite/no-mock HTTP evidence;
- installed-tarball server load passes;
- package includes all three required internal files;
- no unexplained Graphify drift;
- exact-head Security Checks and Benchmark Regression succeed;
- zero unresolved review threads; and
- no mutation caused by WB2 reads.

## Mandatory successor
```text
V4_WB2D_SERVER_WIRING_IMPLEMENTATION
-> V4_WB2D_SERVER_WIRING_RECONCILIATION
```

Only reconciliation may decide whether V4-B1 runtime evidence is closed and
which remaining V4 gate opens.

## Forbidden scope
- no `requestGuards.js`, lockfile, Graph, Kernel, MemoryStore, adapter,
  inspector or pure route-contract modification;
- no persistence, schema, table, index, migration or dependency;
- no external-client route, MCP, CLI, UI, public asset or viewer change;
- no default workspace or caller-controlled trust authority;
- no full receipt or arbitrary audit-detail exposure;
- no retry, repair, approval transition or mutation;
- no version, release, deployment, V4-complete or V5-complete claim.

## Stop conditions
Stop if WB3 behavior cannot be preserved, `server.js` grows, exact workspace
requires truncation, package reachability needs exports/dependencies/lockfile,
positive paths need fake runtime owners, or scope exceeds four files.

## Connector-only limits
Local bootstrap, `node scripts/agent-context.js`, worktree state, local tests,
package dry-run, `git diff --check` and Graphify were unavailable through the
connector. Exact source, Git ancestry, scope and GitHub CI remain controlling.

## Non-claims
This authorization does not claim server wiring, package reachability, no-mock
WB2 runtime evidence, V4 closeout or V5 implementation is complete.
