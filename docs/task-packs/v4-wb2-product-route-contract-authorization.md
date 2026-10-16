# V4-WB2 Product Route Contract Authorization

## Authorization identity

- Repository: `ali-ulu/huqan`
- Exact authorization base: `main @ d0b789e2e74049c09a1ae2ede063ed2a271d2b22`
- Package version: `0.9.1`
- Active roadmap gate: `V4_WB2C_PRODUCT_ROUTE_CONTRACT_AUTHORIZATION`
- Authorized successor: `V4_WB2C_PRODUCT_ROUTE_CONTRACT_IMPLEMENTATION`
- This document authorizes one pure route-contract helper and its targeted
  tests. It does not authorize `server.js` wiring.

## Source-backed decision

PR #254 merged a bounded read-only adapter that can select one exact durable
audit record in one exact workspace and feed the existing Memory Context
Inspector. PR #255 reconciled that implementation and opened only a separate
product-route contract authorization.

The next implementation must mirror the repository's proven WB3 sequencing:

```text
pure route contract
-> reconciliation
-> separate real server wiring authorization
-> server implementation + no-mock smoke
```

The WB2 contract is stricter than the existing WB3 receipt route because WB2's
audit-source adapter requires an explicit workspace. No default-workspace or
cross-workspace fallback is authorized.

## Current source reality

### Existing reusable owners

- `lib/workbench/memory-context-inspector.js` owns the final bounded inspector
  response: `invalid_request`, `not_found`, `read_error` or `ok`.
- `lib/workbench/memory-context-audit-source.js` owns exact `auditId` plus
  workspace selection, the 1024-record scan bound and source-backed mapping.
- `requestGuards.js` and `server.js` already provide rate limiting and API-key
  enforcement used by authenticated JSON routes.
- The existing WB3 route uses a small pure route helper first, then separately
  wires that helper into the real server with a no-mock smoke test.

### Existing server order

The real server currently applies:

```text
viewer gateway
-> OPTIONS handling
-> outer rate limit
-> URL parsing
-> route match
-> method gate
-> API-key gate
-> route-specific validation and read
```

The future WB2 server wiring must preserve that order. Authentication must
happen before adapter or inspector invocation.

### Package boundary

`server.js` is included in the npm package allowlist. The merged WB2 audit
adapter is intentionally not yet listed. The pure route-contract PR must not
change `package.json`. A later server-wiring authorization must explicitly add
both WB2 runtime dependencies to the allowlist if `server.js` requires them:

```text
lib/workbench/memory-context-audit-source.js
lib/workbench/memory-context-route.js
```

Installed-tarball smoke is mandatory for that later wiring gate.

## Exact implementation scope

The authorized successor may add exactly:

```text
lib/workbench/memory-context-route.js
test/v4-wb2c-memory-context-route-contract.test.js
```

No existing file may change.

The production helper should remain under 150 lines. The test owner should
remain under 300 lines where practical.

## Route identity

The reserved future product route is:

```text
GET /api/workbench/memory-context/:auditId?workspaceId=:workspaceId
```

No POST, mutation, approval, action, batch, list or latest-record surface is
authorized.

## Required production contract

The module must export exactly:

```text
ROUTE_PREFIX
parseWorkbenchMemoryContextPath
handleWorkbenchMemoryContextRequest
```

with:

```text
ROUTE_PREFIX = /api/workbench/memory-context/
```

### Path parsing

`parseWorkbenchMemoryContextPath(pathname)` must:

- return `null` for non-matching paths;
- require exactly one non-empty encoded path segment after the prefix;
- decode once with `decodeURIComponent`;
- reject malformed encoding;
- reject control characters;
- reject decoded `/`, `\\`, `?` or `#` characters;
- reject IDs longer than `128` characters rather than truncating them;
- return stable `missing_record_id`, `invalid_record_id` or
  `record_id_too_long` codes; and
- never interpret receipt IDs, provenance IDs, target text or array positions
  as audit-record authority.

Trailing or extra path segments are invalid, not aliases.

### Workspace authority

`handleWorkbenchMemoryContextRequest()` must require an explicit workspace ID:

- non-empty string after trimming;
- maximum `128` characters;
- no control characters;
- no default fallback; and
- stable `missing_workspace_id`, `invalid_workspace_id` or
  `workspace_id_too_long` result.

The future server wiring may obtain this value only from the authenticated
request query parameter `workspaceId`. Request body workspace, headers other
than authentication and stored-record fallback are not authorized.

### Delegation chain

For valid input, the helper must perform only:

```text
createMemoryContextAuditSource(auditOwner, bounded options)
-> inspectMemoryContext({ recordId, workspaceId, source })
-> map inspector status to HTTP status
```

It must not read Graph internals, duplicate adapter mapping, duplicate inspector
normalization or catch and convert unexpected programming errors outside the
existing inspector's read-error boundary.

### HTTP mapping

The pure helper returns `{ statusCode, body }` using exactly:

```text
ok              -> 200
invalid_request -> 400
not_found       -> 404
read_error      -> 502
unknown status  -> 502
```

The inspector body is returned without adding full audit details, receipts,
provenance, target text or private source data.

## Required tests

The exact test owner must cover at least:

1. valid exact path extraction;
2. non-matching path returns `null`;
3. missing audit ID;
4. malformed percent encoding;
5. control characters;
6. encoded slash/backslash/query/fragment characters;
7. extra path segment rejection;
8. 128-character ID acceptance and 129-character rejection;
9. missing, blank, malformed and oversized workspace rejection;
10. valid `ok` mapping to `200`;
11. unknown audit ID mapping to `404`;
12. workspace mismatch mapping to `404`;
13. malformed/throwing source mapping through inspector to `502`;
14. invalid request mapping to `400`;
15. no default workspace or alternate identifier fallback;
16. exact adapter options are bounded and cannot exceed `1024`;
17. the caller options object is not mutated;
18. the returned body contains no full audit event or receipt copy; and
19. the module exposes no mutation, approval or action function.

The pure contract tests may use a minimal Graph-compatible read owner. Real
Kernel/SQLite/server evidence belongs to the later server-wiring smoke gate and
must not be claimed here.

## Acceptance commands

```bash
node --test test/v4-wb2c-memory-context-route-contract.test.js
node --test test/v4-wb2-memory-context-audit-source.test.js
node --test test/v4-wb2-memory-context-runtime-source.test.js
node --test test/v4-wb2-memory-context-inspector.test.js
node --test test/v4-wb3a-trust-receipt-route-contract.test.js
npm test
npm pack --dry-run --json --ignore-scripts
graphify update .
git diff --check
git diff --name-only <exact-base>...HEAD
git status --short
```

Acceptance requires:

- exact two-file implementation scope;
- all targeted tests and full regression exit `0` with zero failures;
- package dry-run unchanged because the helper is not yet server-reachable;
- Graphify has no unexplained unrelated drift;
- exact-head Security Checks and Benchmark Regression succeed;
- zero unresolved review threads; and
- no production route or package reachability claim.

## Mandatory successor sequence

After implementation merges:

```text
V4_WB2C_PRODUCT_ROUTE_CONTRACT_IMPLEMENTATION
-> V4_WB2C_PRODUCT_ROUTE_CONTRACT_RECONCILIATION
-> V4_WB2D_SERVER_WIRING_AUTHORIZATION
```

The later server-wiring authorization must separately bound:

- exact `server.js` insertion point and outer guard order;
- `GET`-only behavior and `405` response;
- API-key rejection before adapter invocation;
- required query workspace and exact path authority;
- `Cache-Control: no-store` on all WB2 responses, including errors;
- `Content-Type`, CORS and `X-Content-Type-Options` behavior;
- no-mock real-server smoke using real Kernel and SQLite Graph;
- unauthenticated, rate-limited, malformed, oversized, unknown,
  cross-workspace and read-error paths;
- before/after node, edge and audit snapshots;
- legacy WB3 and `/api/trust-receipt` route regressions; and
- npm package allowlist plus installed-tarball server smoke.

## Forbidden scope

- no `server.js`, `requestGuards.js`, `package.json`, lockfile or public asset
  change;
- no Graph, Kernel, MemoryStore, audit writer, adapter or inspector change;
- no persistence, schema, table, query, index, migration or dependency;
- no route registration, server startup, MCP, CLI or UI wiring;
- no list, search, batch, latest or default-workspace endpoint;
- no caller-controlled admission, receipt, provenance or mutation authority;
- no full receipt, full audit details, sourceRef or provenanceId exposure;
- no retry, repair, approval transition or mutation;
- no package publication, version, release or deployment change;
- no product-runtime, V4-complete or V5-complete claim.

## Stop conditions

Stop without widening scope if:

- exact workspace cannot remain mandatory;
- path identity requires truncation or alternate-ID fallback;
- existing adapter or inspector contracts must change;
- server or package files are needed in the pure contract PR;
- exact implementation scope cannot remain two files; or
- any mutation or approval surface is required.

## Connector-only limits

During this docs-only authorization, local clone bootstrap,
`node scripts/agent-context.js`, local worktree state, local tests, package
dry-run, `git diff --check` and Graphify refresh were unavailable through the
connector environment. Exact live source, Git ancestry, changed-file scope and
GitHub CI remain controlling evidence.

## Non-claims

This authorization does not claim that:

- the route helper is implemented;
- the route is registered or reachable;
- WB2 is product-runtime proven;
- authentication and rate limiting have been smoke-tested for WB2;
- the adapter is published in the npm package;
- Workbench is complete; or
- V5 implementation has started.
