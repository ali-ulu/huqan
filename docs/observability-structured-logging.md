# Observability Structured Logging and Correlation

Bu dilim, HTTP ve workflow observability sınırlarında **request**, **run** ve **trace** kimliklerinin güvenli structured log metadata’sı olarak taşınmasını sağlar. Structured log satırları JSON’dur ve yalnızca bounded, allowlist edilmiş operasyon metadata’sı içerir.

## Doğrulanan sözleşme

| Alan | Davranış |
| --- | --- |
| Request correlation | Her HTTP request için server-owned `req-<UUID>` üretilir ve response’a `X-Request-Id` header’ı yazılır. Caller’ın gönderdiği request ID güvenilmez ve yeniden kullanılmaz. |
| Workflow correlation | Workflow run için mevcut `runId`, `traceId` ve varsa caller-provided request ID structured log context’ine bağlanır; run ve step observability kayıtlarında trace ID korunur. |
| Bounded IDs | Log kimlikleri en fazla 128 karakterdir ve yalnızca sınırlı identifier karakterlerinden oluşur; newline, whitespace, kontrol karakteri ve uzun değerler düşürülür. |
| Allowlist | Log fields yalnızca route, method, status, errorCode, workspaceId, runId, traceId, durationMs, outcome ve runtime alanlarından oluşur. |
| Redaction | Prompt, goal, input, output, secret, credential, error message, body ve response payload structured log’a yazılmaz. Hata kaydında yalnız bounded error code tutulur. |
| Sink isolation | Logger sink hata verirse request, worker veya fail-closed karar yolu bozulmaz. |
| Production callers | HTTP server error boundary’leri ve workflow run start/finish/failure noktaları helper’ı kullanır; mevcut ürün response payload’ları değiştirilmez. |

## Kapsam sınırları

Bu çalışma structured log metadata ve correlation wiring için source/test kanıtıdır. Harici log aggregation, distributed tracing backend’i, OpenTelemetry exporter, retention/SIEM politikası, tüm bağımlılıkların iç loglarının dönüştürülmesi, hosted deployment veya operasyonel SLA kanıtı değildir. Request ID response header’ı public payload veya observability API response schema’sına ek bir hassas alan olarak taşınmaz.
