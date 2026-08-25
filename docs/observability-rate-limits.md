# Observability Rate Limits

**Status:** Implemented for the local-first HTTP runtime.

Observability HTTP routes apply rate limits **after authentication and exact workspace validation**. Invalid or unauthorized requests therefore keep their existing `400`/`403` behavior and do not consume an observability quota.

## Buckets and defaults

| Bucket | Protected operations | Per-subject window | Per-workspace window | Concurrent SSE limit |
| --- | --- | ---: | ---: | ---: |
| `read` | `GET /metrics`, `/events`, `/runs`, `/queue`, `/alerts`, `/alert-rules` | 120 / 60 s | 120 / 60 s | — |
| `stream` | `GET /stream` | 12 / 60 s | 12 / 60 s | 2 |
| `queue` | `POST /queue` | 30 / 60 s | 30 / 60 s | — |
| `alerts` | `POST /alert-rules`, `DELETE /alert-rules/:id` | 30 / 60 s | 30 / 60 s | — |

A request must pass both the authenticated subject bucket and the workspace bucket. This prevents one principal from exhausting a workspace and prevents one principal from bypassing a workspace-wide ceiling by changing the requested workspace. Stream capacity is also checked independently for the subject and workspace and is released when the request or response closes.

A limited request returns HTTP `429` with the stable error code `OBSERVABILITY_RATE_LIMITED` and a whole-second `Retry-After` header. The response remains `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## State boundary

The limiter is an intentionally bounded in-memory sliding window owned by one observability router instance. It bounds retained keys and evicts inactive entries; it is reliable for the supported local-first single-process server model. Counters are not persisted and are not coordinated between processes or hosts.

A deployment with multiple server processes must enforce an equivalent shared limit at its trusted edge or provide a shared rate-limit store. The current implementation does **not** claim distributed enforcement, cross-process fairness, or a hosted multi-tenant abuse-control service.

Existing query-shape guards remain active as a separate defense: they bound query length, parameter count, cursor length, and page size before service use. Rate limiting does not replace authentication, workspace authorization, validation, or payload redaction.
