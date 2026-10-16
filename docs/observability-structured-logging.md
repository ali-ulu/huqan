# Observability Structured Logging and Correlation

Bu sözleşme HTTP, CLI, MCP ve workflow sınırlarında güvenli structured logging davranışını tanımlar. Her structured log satırı JSON'dur; operasyon metadata'sı allowlist ile sınırlıdır ve secret-scrub gate üzerinden geçirilir.

## O4 canonical record

Her kayıt en az şu alanları taşır:

| Alan | Davranış |
| --- | --- |
| `event` | Bounded event identifier. |
| `reason` | Bounded machine-readable reason; caller vermiyorsa error code/outcome, son çare `unspecified`. |
| `request_id` | UUID. HTTP request correlation içindeki `req-<UUID>` canonical UUID'ye çevrilir; request context olmayan sistem loglarında yeni UUID üretilir. |
| `timestamp` | ISO 8601 UTC timestamp. |
| `workspace_id` | Exact bounded workspace ID; sistem-scope kayıtlarında `system`. |
| `agent_id` | Agent bağlamı varsa bounded identifier. |
| `level` | `debug`, `info`, `warn` veya `error`. |

Mevcut local consumer'ları kırmamak için `requestId`, `traceId`, `runId`, `workspaceId` ve `agentId` compatibility alias'ları korunur.

## Güvenlik ve seviye politikası

- `HUQAN_LOG_LEVEL` minimum emit seviyesini belirler; varsayılan `info`'dur.
- Allowlist dışında prompt, goal, input/output payload, credential ve body alanları structured log'a girmez.
- Allowlist içindeki değerler de `lib/secret-scrub-gate.js` ile scrub edilir.
- Logger sink hatası request, worker veya fail-closed karar yolunu değiştirmez.
- Request correlation server-owned'dur; caller tarafından gönderilen request ID yeniden kullanılmaz.

## Retention sınırı

`writeStructuredLog` kendi başına disk persistence yapmaz; JSON satırını seçilen sink'e verir. HUQAN içinde kalıcı observability kayıtları `observability_events` üzerinden tutulur ve `lib/observability/retention.js` içindeki event retention politikasına tabidir. Böylece structured logging yeni, retention dışı ikinci bir kalıcı log deposu oluşturmaz. Harici stdout/stderr collector retention süresi ise collector'ın kendi operasyon politikasının parçasıdır.

## Doğrulama

`npm run check:structured-log` canonical alanları, UUID/timestamp formatını, secret scrubbing'i ve `HUQAN_LOG_LEVEL` filtresini doğrular. Bu gate `npm run verify` manifestine dahildir.
