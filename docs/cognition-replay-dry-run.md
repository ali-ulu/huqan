# M3: mühürlü deneyimden yazmasız aday önizlemesi

İlgili iş: #4069. Bu dilim opt-in aday önizlemesidir; ölçülmüş öğrenme kazanımı değildir.

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
`source_operation_mismatch` ile kaynak atlanır, admission ve derleme çağrılmaz. Bu akış yeni
serbest biçimli kod veya parametre icat etmez.

Qualification girdileri kaynak artifact'larından bağımsız olmalıdır. Her girdinin
`before`, `expectedAfter` ve hesaplanan çıktı metninin SHA-256'sı, kaynağın
`execution_finished.payload.changes[].afterSha256` digest'leriyle karşılaştırılır.
Herhangi biri eşleşirse istek `qualify` çağrılmadan
`qualification_source_overlap` ile aday reddedilir. Girdi `id` değeri yalnız
etikettir; bağımsızlık kanıtı değildir.

Normal journal açılışı tablo ve dayanıklılık ayarları yazabildiği için önizleme
ayrı salt okunur bellek görüntüsü kullanır; yalnız checkpoint edilmiş depolar
desteklenir. Hardlinkli kaynak, dolu WAL veya rollback journal varsa açılış
reddedilir; kaynakta eşzamanlı yazma yapılmamalıdır. Mühür ve workspace denetimi mevcut
`readSealedRun` üzerinden yapılır. Desteklenmeyen veya güvenle okunamayan depo
reddedilir; yeni DB, Graph veya aday kaydı yaratılmaz. CLI yolu Kernel
kurulmadan ayrılır.

Önizleme kesiminden ileri başlangıç zamanlı koşular, bağımlılık ve derleme
kaynağına veya qualification artifact karşılaştırmasına katılmaz.

Eşleşen native kaynakta birden çok başlangıç, eylem, yönlendirme, yürütme sonucu veya
verification varsa önizleme `native_observation_ambiguous` ile durur; ilk
gözlemi seçerek sonraki çelişkili sonucu gizlemez.

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
`support` bütün seçilmiş desteği korur. `compiledSupport`, mevcut derleyicinin
bir ana kaynak ve en çok 32 baseline sınırına uyan bağımsız temsilcilerdir;
kopya koşular derleme desteğini şişirmez. Metin değiştirme, gerçek Coder gibi
replacement işaretlerini yorumlamadan harfiyen yapılır.
Intake yalnız aday üretmek için `admissionPool.propose` çağırabilir;
`reflective-promotion.propose`, kalıcı kayıt, onay, canary veya terfi otomatik
çağrılmaz. Policy ve capability
nesneleri öğrenilmez; mevcut kabul/terfi yolu ayrı kalır.

`sourceRunIds`, yeni replay adayının mühürlü referans kaynaklarıdır; eski native
koşunun bunları karar öncesinde gördüğü veya kullandığı iddia edilmez. İlk dilim
yalnız `parentVersion: 0` ile yeni aday sürümü derler; mevcut kabul edilmiş
sürümü değiştirmez. Başlangıç zamanı yalnız sıralama için kullanılır; eski
sonuçların karar anındaki erişilebilirliğini kanıtladığı varsayılmaz.

Doğrulama kapsamı: gerçek CLI alt süreci, native Coder'ın mühürlü kayıtları, kopyalanmış
kaynak desteği, yanlış workspace, bozuk/açık journal, ayrı girdi oracle'ı ve
komut öncesi/sonrası dosya/DB/sidecar karşılaştırması. Bu belge test sonucu
yerine geçmez; kazanım ve B4/G3 ölçümü ayrı çalışmadır.
