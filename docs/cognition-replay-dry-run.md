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

## Açık operatör kabulünün kaydı

Mevcut authority-backed `terfi` akışında `--journal <mutlak experience.db yolu>`
kabul fişini aynı experience journal'a ayrı, kapatılmış bir koşu olarak yazar.
Normal dry-run bu işlemi çağırmaz. Journal modu procedure artifact'ı, mevcut
authority kararı ve aynı argv ile dört dosyanın tam digestlerini gerektirir.
Legacy veya eksik yetkiyle fiş hazırlanmadan durur.

Aday ve bağlı dosyaları `procedure` tam derlenmiş nesnesini, mevcut
`qualification` sonucunu ve `sourceRunHashes: [{runId, sourceHash}]` bağlarını
taşır. Dry-run'ın `compiledSupport` ile `sourceHashes` çifti de kullanılabilir.
Kaynaklar eylemden önce mühürlerinden doğrulanır; derlenmiş nesnenin hash'i
yeniden hesaplanır. Rollback onaylanmışsa eski yöntemin qualification ve
kaynak bağları da önceden bulunmalıdır.

Fiş önceki/sonraki yöntemin tam hash ve sürümünü, workspace/capability'yi,
dosya digestlerini ve gerçekleşen `promoted` veya `rolled_back` sonucunu içerir.
Authority outcome'u fişin hash'ini imzalar. Kaynak native koşular değiştirilmez.
Bu kayıt doğrulaması tek başına Coder aktivasyonu veya yürütme yetkisi değildir.

Outcome kaydedilip journal yazımı yarıda kalırsa `apply` aynı girdilerden
imzalı hash'i yeniden kurar ve yalnız eksik kayıt kuyruğunu tamamlar; terfiyi
yeniden çalıştırmaz. Girdiler eksik/değişmişse veya hash eşleşmiyorsa görünür
kısmi sonuç verir. Gerçek Coder'ın bu kabulü kullanması aşağıdaki isteğe bağlı
canlı authority kontrolüne bağlıdır.

## Coder için canlı kabul kontrolü

`coder <task.json> --journal <mutlak experience.db yolu> --promotion-approval <approvalId> --promotion-capability <capabilityId>`
seçenekleri, journal'daki mühürlü fişi kurulu authority'nin anahtarıyla
doğrular. Canlı karar, tüketim kaydı, gerçekleşen outcome ve fiş hash'i aynı
workspace ve eyleme bağlı olmalıdır. Görev girdisindeki bir boolean bu kabulü
üretemez. Mevcut dosya değişikliği yetkisi ve bağımsız kabul testi ayrıca gerekir.

Kontrol, fişin imzalı outcome kaydından güncel authority başlığına kadar geçmişi
okur. Aynı capability için daha sonraki tüketilmiş terfi, başarısız veya yarım
kalmış olsa da eski fişi durdurur; yeni journal fişinin varlığına güvenilmez.
Bozuk, eksik, değişen veya 10.000 kayda ulaşan geçmişte çalıştırma reddedilir.
Başka capability'nin terfisi tek başına bu kabulü geçersiz kılmaz.

Kabul yalnız senkron Coder çağrısı boyunca yaşayan, tek kullanımlık bir iç
nesneye bağlanır. Dosya yazımından önce gerçekten seçilen yöntemin tam hash'i
ve capability'si karşılaştırılır; eşleşmeyen veya tekrar kullanılan nesne
reddedilir. Yeni süreç bu denetimleri yeniden yapar; nesne diske kaydedilmez.

Mevcut authority API'si son geçmiş okumasıyla dosya yazımı arasında süreçler
arası atomik kilit sağlamaz. Bu bağlantı böyle bir garanti veya genel öğrenme
kazanımı iddiası taşımaz.
