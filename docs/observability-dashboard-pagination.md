# Observability Dashboard Run History pagination

Run History, observability v1 runs endpoint’inin mevcut cursor tabanlı bounded sayfalarını kullanır. İlk sorgu `limit=20`, seçili `windowMs` ve mevcut workspace kimliğiyle yapılır. Backend `hasMore` ve `nextCursor` döndürürse `Next` düğmesi etkinleşir; devam sorgusu yalnızca bu cursor’ı URL-encode ederek aynı workspace ve zaman penceresiyle ister.

İstemci yalnızca response sayfasını mevcut listeye ekler ve `hasMore` false olduğunda düğmeyi devre dışı bırakır. Cursor yoksa yeni sayfa isteği yapılmaz. Backend’in `limit` ceiling’i korunur; UI sınırsız veri istemez ve pagination’ı client-side tüm veri yükleme biçimine dönüştürmez. Time-window değişimi `loadAll()` çağırarak Run History’i ilk sayfaya sıfırlar.

Run rows backend tarafından workspace-scoped ve redacted projection olarak sağlanır; UI yalnız status, runtime, run kimliği, tool özeti, zaman ve bounded usage alanlarını gösterir. Cursor sıralaması backend’in `updated_at DESC, run_id DESC` sözleşmesine tabidir.

Bu PR event history pagination, queue/alert archive pagination, virtualization, distributed cursor durability, deployment, üçüncü taraf entegrasyon veya production SLA kanıtı değildir. Run History pagination’ın gerçek backend sayfalarıyla bağlandığını service, dashboard contract ve browser smoke testleri birlikte doğrular.
