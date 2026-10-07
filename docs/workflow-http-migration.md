# Workflow HTTP contract migration

The canonical HTTP workflow contract is version `2.0.0`. Clients should discover
capabilities at `GET /api/v2/workflows` and the machine-readable OpenAPI 3.1
document at `GET /api/v2/openapi.json`. Both are public metadata endpoints and
return `Cache-Control: no-store`.

Only entries whose `availability.api` is `true` are executable over HTTP and
only those operations appear in the OpenAPI document. `learn-review`,
`ingest-preview`, `agent-plan`, and `agent-run` ARE live HTTP routes: they are
advertised with `availability.api = true` in `lib/workflow-contract.js`, they
are handled at runtime (`/api/v2/workflows/learn` and `/api/v2/ingest/preview`
by `lib/http/workflow-data-routes.js`, `/api/v2/agent/plan` and
`/api/v2/agent/runs` by `lib/http/agent-workflow-routes.js`), and
`workflowOpenApiDocument()` includes them in
the OpenAPI output. Invalid calls to these routes fail with 400/405-style
workflow envelopes, not 404.

Three of these four now have a panel surface as well: `agent-plan` and
`agent-run` through the workbench action select (#1878), and `ingest-preview`
alongside `ingest-execute` as the two-step batch flow (#1878). `learn-review`
is still `availability.ui = false` and reachable only over HTTP, MCP and the
CLI; the remaining unsurfaced capabilities are tracked in #1878.

The legacy `GET /api?q=...`, `POST /api/ingest`, and `GET /api/trust-receipt`
routes remain supported in 2.x. New clients should prefer the versioned workflow
routes where an equivalent is advertised. No removal date is declared. A future
removal requires a new contract major version and an explicit deprecation date.

Authenticated operations use `Authorization: Bearer <HUQAN_API_KEY>`. Routes
which declare a workspace require the exact `workspaceId` named by their schema.
JSON operations reject invalid input; each operation's `x-maxBytes` declares
its enforced body limit. Workflow responses are non-cacheable. Server rate limiting is
fail-closed and may return HTTP 429; clients must not treat it as completion.
Cross-origin responses are emitted only for loopback HTTP(S) origins. Preflight
permits `GET`, `POST`, and `OPTIONS` with a ten-minute maximum age. Operation
failures use `WorkflowEnvelope`; authentication, rate-limit, and other middleware
failures retain the compatible `ApiError` shape during the 2.x migration.

## HTTP and MCP input schemas: one source per field (#3593)

A workflow that serves both surfaces has an HTTP request schema
(`lib/workflow-contract.js`) and an MCP input schema
(`lib/mcp-tool-catalog-*.js`). #3593 decided the single source: the HTTP
request schema is canonical for a field both surfaces share, and the MCP input
schema is derived to match it. Fields only one surface has stay on that
surface.

The 1.0.0 major release removed the unintended drift:
- shared bounds now match on both surfaces: `question` 1..4000, `statement`
  1..4000, `goal` 1..500, `claim`/`query` 1.. bounded, `workspaceId` 1..128
  (except `huqan.verify`, whose MCP `workspaceId` stays 1..256 — narrowing it
  to 128 would have been a breaking change once main reached 1.0.0);
- `maxSnippet` and `summarize` (web-research) are now declared on the MCP tool
  as they already were on HTTP;
- HTTP `verify` names `statement` canonically (MCP parity); `claim` stays an
  accepted HTTP alias for callers written before the rename.

`test/agent-exit-reasons-and-schema-divergence.test.js` pins the remaining
differences as surface-specific, each with its reason:
- the HTTP agent/ask/advocate routes are workspace-bound (`workspaceId`
  required, `const "default"`), while the MCP tool answers in the session
  workspace and carries no such argument;
- `approval-decision` addresses the approval through the route
  (`/api/v2/approvals/{id}/decision`), so the MCP tool carries
  `approvalId`/`workspaceId` as arguments and the HTTP body carries only the
  decision;
- `ingest-execute` has no HTTP body schema of its own (open OBJECT_SCHEMA), so
  the MCP tool's 11 execution fields are MCP-only;
- `learn-review` keeps HTTP-only source fields and MCP-only ingestion controls
  (`maxSentences`, `skipConflicts`); its HTTP body ceiling (1 MiB) differs from
  the MCP sanitizer cap.

