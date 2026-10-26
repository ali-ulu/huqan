# M3: mühürlü deneyimden yazmasız aday önizlemesi

Durum: uygulama taslağı; henüz doğrulanmış üretim akışı değildir. İlgili iş: #4069.

```text
huqan terfi --from-replay --dry-run --journal experience.db --workspace default --request replay.json --json
```

`replay.json`, desteklenen `replace_text` işleminin açık parametrelerini ve
kaynaklardan ayrı doğrulama girdilerini bildirir:

```json
{
  "capabilityId": "stored-release-replacement",
  "params": { "path": "docs/notes.md", "oldText": "v1.0.0", "newText": "v1.1.0" },
  "parentVersion": 0,
  "qualificationInputs": [
    { "id": "unseen", "before": "new context v1.0.0", "expectedAfter": "new context v1.1.0" }
  ]
}
```

Parametreler operatörün bildirimidir ve admission ile `compile()` öncesinde
mühürlü kaynağın işlem kaydıyla karşılaştırılır. İşlem kaydı
`routing_decided.payload.execution`, yoksa `action_proposed.payload` olur.
Eşleşme için `operationType === "replace_text"`, `path === params.path`,
`findSha256 === sha256(params.oldText)` ve
`replaceSha256 === sha256(params.newText)` gerekir (UTF-8 metnin hex SHA-256'sı).
`readSealedRun().sourceHash` run projeksiyon hash'idir, işlem hash'i değildir ve
bu eşleşmede kullanılmaz. Uyuşmazlıkta fail closed uygulanır:
`source_procedure_mismatch` döner, admission ve derleme çağrılmaz. Bu akış yeni
serbest biçimli kod veya parametre icat etmez.

Qualification girdileri kaynak artifact'larından bağımsız olmalıdır. Her girdinin
`before` ve `expectedAfter` metninin SHA-256'sı, kaynağın
`execution_finished.payload.changes[].afterSha256` digest'leriyle karşılaştırılır.
Herhangi biri eşleşirse istek `qualify` çağrılmadan
`qualification_input_not_independent` ile reddedilir. Girdi `id` değeri yalnız
etikettir; bağımsızlık kanıtı değildir.

Normal journal açılışı tablo ve dayanıklılık ayarları yazabildiği için önizleme
ayrı salt okunur açılış kullanır. Mühür ve workspace denetimi mevcut
`readSealedRun` üzerinden yapılır. Desteklenmeyen veya güvenle okunamayan depo
reddedilir; yeni DB, Graph veya aday kaydı yaratılmaz. CLI yolu Kernel
kurulmadan ayrılır.

M2 hatası yalnız kaydedilmiş yürütme hedefi ve bağımsız disk okuma hash'leri
uyuştuğunda hesaplanır. Beklenti veya gözlem yoksa epizot puanlanmaz. Eski
Experience kayıtlarında karar öncesi M9 beklentisi bulunmadığından sonradan
geçmiş değer hesaplanmaz; M8'in açıkça etiketlenmiş sıfır önseli kullanılır.

Kaynak desteği, gözlenmiş artifact digest'leri ve kayıtlı ortak bağımlılıklar
üzerinden sayılır. Farklı koşu kimlikleri ya da journal hash'leri bağımsız kaynak
kanıtı değildir. Yetersiz veya yalnız negatif destek olumlu prosedür oluşturmaz.
Bu kaynak gruplaması bağımsız gerçek görev örneklemi veya istatistiksel kazanım
iddiası değildir.

Olumlu aday mevcut öğrenme intake'i ve derleyiciyle sürümlenir; yalnız kaynak
artifact'larını tekrar etmeyen ayrı girdilerde qualification geçen derleme
listelenir. Sonuç daima `registered: false` ve `CANDIDATE_ONLY` taşır.
Intake yalnız aday üretmek için `admissionPool.propose` çağırabilir; kayıt, onay,
canary ve terfi otomatik çağrılmaz. Policy ve capability
nesneleri öğrenilmez; mevcut kabul/terfi yolu ayrı kalır.

Doğrulama: gerçek CLI alt süreci, native Coder'ın mühürlü kayıtları, kopyalanmış
kaynak desteği, yanlış workspace, bozuk/açık journal, ayrı girdi oracle'ı ve
komut öncesi/sonrası dosya/DB/sidecar karşılaştırması. Bu belge test sonucu
yerine geçmez; kazanım ve B4/G3 ölçümü ayrı çalışmadır.
