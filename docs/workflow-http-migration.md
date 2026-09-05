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

None of these four is exposed in the panel UI (`availability.ui` is `false`
for each); surfacing them in the panel is tracked separately (#1877, #1878).

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
