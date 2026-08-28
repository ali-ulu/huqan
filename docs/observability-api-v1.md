# Observability API v1

HUQAN observability HTTP sözleşmesinin canonical yeni yüzeyi `/api/observability/v1` prefix’idir. Mevcut `/api/observability/...` yolları **v1 için geriye dönük uyumluluk alias’ı** olarak korunur; yeni istemciler versioned prefix’i kullanmalıdır. Makine tarafından okunabilir OpenAPI 3.1 belgesi public metadata endpoint’inden alınır:

```text
GET /api/observability/openapi.json
```

Bu metadata endpoint’i workspace verisi içermez ve yalnızca `GET` için public’tir. Versioned telemetry ve queue/alert yolları bearer API key, exact `workspaceId` scope’u ve workspace authorization gerektirir.

## Endpoint sözleşmesi

| Kaynak | Versioned path | Davranış |
| --- | --- | --- |
| Health/readiness | `/api/observability/v1/health`, `/ready` | Workspace-scoped liveness/readiness; `ready` dependency başarısında `503` dönebilir. |
| Metrics | `/api/observability/v1/metrics` | Bounded metrics, queue summary, alert özeti ve workspace-scoped internal runtime counters; `windowMs` bounded’dir. |
| Events | `/api/observability/v1/events` | Redacted event page; bounded `windowMs`, `cursor`, `limit`, event type ve run filtreleri. |
| Runs | `/api/observability/v1/runs` | Redacted run page; stable cursor ordering ve tool usage özeti. |
| Queue | `/api/observability/v1/queue` | Bounded queue read ve authenticated enqueue. |
| Alerts | `/api/observability/v1/alerts` | Bounded workspace alert read. |
| Alert rules | `/api/observability/v1/alert-rules` | Rule read/create ve scoped delete. |
| Stream | `/api/observability/v1/stream` | Workspace-scoped redacted SSE event stream. |

Tüm JSON response’ları `no-store` ve `nosniff` header’larıyla döner. Başarılı JSON response’ları `{ ok: true, data }` zarfını; observability route-level hata response’ları `{ ok: false, error: { code, message } }` zarfını kullanır. Observability authenticated route’larının `401` yanıtı `UNAUTHORIZED` kodunu taşır; diğer HTTP yüzeylerinin mevcut auth envelope’ları bu slice’ın kapsamı dışındadır.

## Sınırlar ve güvenlik

Pagination cursor tabanlıdır; event/run listelerinde default limit bounded’dir, `windowMs` 1 saniye ile 31 gün arasında normalize edilir ve route query guard maksimum `100` limit ile `512` karakter cursor uygular. Event ve run response modelleri plaintext `goal`, `prompt`, `input`, `output`, `secret`, `credential` ve `authorization` alanlarını yayınlamaz. Run’larda yalnızca `goalDigest` ve `goalLength`; queue job’larında yalnızca digest ve uzunluk taşınır. Event payload’ı persistence öncesi `safePayload` redaction ve byte/öğe sınırlarından geçer. Metrics response içindeki `internal` alanı yalnızca process-local, workspace-scoped ve bounded sayaçları (`eventWrites`, `droppedEvents`, `projectionFailures`, summary/alert timing, database operation timing ve subscriber count) içerir; payload, hata metni, prompt/goal veya credential taşımaz. Database timing, service’in instrumented persistence/query işlemlerinin çağrı, toplam süre ve slow-call sayaçlarını kapsar; tüm SQLite işlemleri veya dağıtık sistem gecikmesi için telemetry iddiası değildir. Event write failure özgün storage hatasını korur ve başarısız row eklenmez; write başarılı olup projection başarısız olursa persisted event korunur ve projection failure counter artar. Bu sayaçlar durable/distributed telemetry değildir ve kendi kendine observability event’i üretmez.

Standard error code grupları auth, workspace/permission, validation, rate limit ve storage/unavailable sınıflarına ayrılmıştır. Rate limit response’ları `429` ve `Retry-After` header’ı içerir. Unknown/unrouted paths default-deny ve non-disclosure davranışıyla `404` olarak kalır; OpenAPI’de yalnız gerçekten servis edilen v1 paths bulunur.

Bu belge local HTTP contract, OpenAPI metadata ve compatibility alias davranışını kapsar. Hosted deployment sequencing, external notification delivery, third-party interoperability, public multi-tenant authority veya production SLA iddiası taşımaz.
