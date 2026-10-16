# Observability Dashboard Event History

Observability dashboard’ındaki **Event History** görünümü, mevcut redacted events API’sinin bounded cursor pagination yüzeyini tarayıcıya bağlar. İlk ve devam sorguları `limit=20` kullanır; seçili workspace ortak `get` yardımcısı tarafından eklenir; seçili zaman penceresi, event türü ve isteğe bağlı run ID aynı sorgu kapsamını korur.

## Sorgu sözleşmesi

İlk sayfa `GET /api/observability/v1/events?limit=20&windowMs=<selected>&eventType=<optional>&runId=<optional>` biçiminde istenir. API’nin legacy `/api/observability/events` alias’ı aynı davranışı korur. `Next` yalnızca response `hasMore=true` ve geçerli `nextCursor` bulunduğunda etkinleşir. Devam sayfası cursor’ı URL query encoder ile taşır; kullanıcı Filter’a bastığında cursor state ve önceki satırlar ilk sayfaya resetlenir.

| Alan | Davranış |
| --- | --- |
| Workspace | Ortak authenticated `get` yardımcısı `workspaceId` ekler. |
| Time window | `windowMs` seçilen dashboard penceresinden alınır; backend 1 saniye–31 gün aralığına normalize eder. |
| Event filter | `eventType` seçilirse exact event türü olarak gönderilir. |
| Run filter | `runId` boş değilse exact run ID olarak gönderilir ve 128 karakterle sınırlıdır. |
| Page size | Her HTTP yanıtı için `limit=20`; `Next` sonraki cursor’ı ister. |
| Final page | `hasMore` veya `nextCursor` yoksa `Next` disabled kalır. |

## Gösterim ve gizlilik

Satırlar yalnızca redacted event özetini gösterir: event türü, status, oluşturulma zamanı, run ID, tool ve duration. Event payload’ı, prompt, goal, input/output, secret veya credential dashboard satırına taşınmaz. Loading, empty ve request error durumları ayrı status alanında kullanıcıya duyurulur; status alanı `role="status"` ve `aria-live="polite"` kullanır.

Bu dilim event geçmişi için browser UI pagination/filter bağlantısını ve gerekli bounded backend time-window forwarding’ini kapsar. Queue veya alert arşiv pagination’ı, client-side virtualization/retained-row cap, server-side replay, deployment, hosted SaaS, external notification delivery veya production SLA kanıtı değildir.
