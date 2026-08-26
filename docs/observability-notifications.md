# Observability Notification Adapter

Bu slice, observability alert’leri için güvenli bir notification adapter boundary’si ve alert lifecycle’a explicit service wiring’i tanımlar. Adapter’ın tek concrete uygulaması injected transport ile çalışan **HTTPS webhook** adapter’ıdır. `createObservabilityService({ notificationAdapter })` ile adapter açıkça verilirse `alert_firing`, `alert_acknowledged` ve `alert_resolved` olayları adapter’a bildirilir; adapter verilmezse mevcut no-op davranış korunur. Varsayılan HUQAN server runtime’ı bu adapter’ı otomatik oluşturmaz veya dış endpoint’e kendiliğinden istek göndermez; bu nedenle güvenlik ve dış sistem yan etkileri explicit caller configuration’ına bağlı kalır.

## Sözleşme

| Alan | Kural |
| --- | --- |
| Endpoint | Yalnız `https:` URL; kullanıcı adı/parola, query veya fragment kabul edilmez. |
| Secret | Constructor’da 16–512 karakter; yalnız HMAC-SHA256 signature üretiminde kullanılır, payload veya result içine yazılmaz. |
| Payload | `notificationId`, `type`, `workspaceId`, allowlist alert alanları ve bounded `safePayload` metadata. Goal, prompt, input, output, secret, credential ve authorization alanları taşınmaz. |
| Idempotency | Başarılı `notificationId` değerleri bounded in-memory delivered set içinde tutulur; aynı adapter instance’ındaki tekrar `duplicate: true` olarak no-op döner. |
| Retry | En fazla 5 attempt; timeout bounded 100–30.000 ms; exponential backoff bounded ve `Retry-After` header’ı varsa dikkate alınır. Yalnız timeout/network, 408/425/429 ve 5xx yanıtları retry edilir. |
| Failure | 4xx retry edilmez; timeout, retry exhaustion ve HTTP rejection typed result code ile döner. Adapter failure caller’ın telemetry write akışına exception olarak sızmaz; `notifySafely` kontrollü failure result üretir. |

Webhook body’si deterministic JSON olarak imzalanır. Signature `X-Huqan-Notification-Signature: sha256=<hex>` header’ında; notification id ise `X-Huqan-Notification-Id` header’ında taşınır. Başarılı response yalnızca `2xx` aralığında kabul edilir.

## Doğrulama sınırı

Regression testleri HTTPS-only URL validation, secret/payload redaction, deterministic HMAC header, transient retry ve backoff, timeout, non-retryable 4xx, bounded attempts, duplicate suppression ve failure isolation davranışlarını; service wiring testleri ise lifecycle event bildirimini ve adapter failure’ın telemetry/state geçişlerini bozmamasını injected fake adapter ile doğrular. Bu testler gerçek üçüncü taraf endpoint’ine gönderim veya external notification delivery kanıtı değildir. Persistent delivery ledger, distributed idempotency, webhook receiver interoperability, hosted secret management ve varsayılan server’da automatic external configuration ayrı acceptance dilimleridir.
