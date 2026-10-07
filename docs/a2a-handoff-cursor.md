# A2A handoff sonlandırma + dayanıklı cursor — R23

`require('huqan').createA2aHandoffCursor(directory)` aktif delegator imlecini
tutan public SDK sınırıdır. Kayıt `(from_agent_id, to_agent_id,
route_receipt_id, timestamp)` dörtlüsüdür ve replay/task depolarıyla **aynı
dizinde** dosya başına kayıt olarak durur; yeni tablo veya veritabanı eklemez.

Yazım `wx` (exclusive-create) + `fsync` + `0o600` ile olur; mekanizma
`lib/a2a/replay-store.js` ve `lib/a2a/task-store.js` ile aynıdır:

- aynı baytın ikinci yazımı idempotent (`duplicate`),
- aynı `route_receipt_id` altında farklı içerik `handoff_identity_conflict`
  olur; ilk kayıt ayakta kalır (at-most-once aynası),
- kapanmış bir id üzerine kayıt `cursor_closed` ile reddedilir; kapanmış
  imleç asla yeniden açılmaz.

`require('huqan').resolveHandoffTermination({ handoffReason, closedBy })`
route receipt `handoff_reason` tüketicisidir: insan/hedef handoff'unu ayrı
sonlandırma nedeniyle kapatır (`human_handoff` / `target_complete`). Telde
taşınan tek neden eski `delegated_task` kalır; route receipt şeması değişmez,
bu yüzden tel-format migrasyonu gerekmez. Bilinmeyen neden veya kapatıcı
yazmadan önce reddedilir (fail-closed).

`closeCursor` sonlandırmayı ayrı `.handoff-terminated` dosyasına yazar; ilk
kapatma ayakta kalır. Bozuk kayıt `corrupt` döner ve asla resume edilmez.

Doğrulama: `test/a2a-handoff-cursor.test.js` gerçek dosya kalıcılığına karşı
kayıt → yeniden başlatılmış örnekten okuma (resume kanıtı), insan/hedef
ayrımı, çakışma, kapanmışı yeniden açmama ve bozuk kaydı kapsar.
`node scripts/a2a-handoff-cursor-mutation.js` sonlandırma eşlemesi devreden
çıkarıldığında ayrım testinin kırıldığını doğrular; kaynak dosyasını
değiştirmez. Harici A2A uygulamalarıyla uyumluluk ayrıca ölçülmelidir.

## Handoff bağlamı ve devam kararı (#3489)

`recordCursor` isteğe bağlı serbest metin `handoff_context` alır. Kayda metin
değil yalnız SHA-256'sı yazılır (`handoff_context_hash`, şema
`v5-a2a-handoff-cursor-v2`); bağlamsız kayıt eski v1 biçiminde kalır.

`resumeCursor(routeReceiptId, { handoffContext })` devam kararını kanıta bağlar:
bağlamla kaydedilmiş bir cursor yalnız aynı metin sunulunca devam eder; eksik
metin `handoff_context_required`, farklı metin `handoff_context_mismatch` ile
reddedilir. v1 cursor bağlamsız devam eder, ama sunulan bir bağlamı
doğrulayamayacağı için `handoff_context_unrecorded` ile reddeder. Bulunamayan,
kapanmış veya bozuk cursor hiçbir koşulda devam etmez.

Tip bildirimi (`index.d.ts`) bu PR'da değişmedi: mevcut bir bildirimi
genişletmek API sözleşme kapısında major sürüm sayılıyor. Doğrulama:
`test/a2a-handoff-context.test.js`.
