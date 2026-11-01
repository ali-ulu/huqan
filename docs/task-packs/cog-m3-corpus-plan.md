# M3/B4 — Bağımsız corpus hazırlama planı

İş: [#4465](https://github.com/ali-ulu/huqan/issues/4465).
Program: [#4060](https://github.com/ali-ulu/huqan/issues/4060).
Durum: `PLAN_ONLY`; H1 deneyi `NOT_RUN`; bağımsız corpus `NOT_READY`.
Kaynak tabanı: `ef9e2d650740aebd7d358559f0d6254f6a02f83d`.

Bu teslim yalnız bu plan dosyasıdır. Veri toplama, yeni çalıştırıcı,
onay üretme, deney yürütme, commit/push veya issue kapatma yetkisi vermez.
Sonraki dosya ve yürütme kapsamları ayrıca onaylanır.

## 1. Mevcut kanıt ve yeniden kullanım

- [M3 ön-kaydı](cog-m3-replay-preregistration-20261027.md), H0/H1,
  ayrıştırılmış kaynak/qualification/holdout ve aynı yürütme hattını tanımlar.
  Bu plan ön-kaydın sabitlerini veya başarısızlık ölçütlerini değiştirmez.
- [Aile değerlendirme sözleşmesi](cog-m3-family-evaluation-contract.md),
  #4469 ile main'e giren salt okunur Lab bağlantısının sınırıdır.
- [Önceki karakterizasyon](cog-m3-b4-replay-result-20261030.md) ve onun
  [JSON kaydı](cog-m3-b4-replay-result-20261030.json), 24 holdout/8 transfer
  etiketi ve K=3 taşır. Bu, K=32 bağımsız native H1 deneyi değildir.
  Etiketleri yeniden adlandırmak veya sayıları eşleştirmek corpus üretmez.
- Mevcut `lib/cli-replay.js` aynı snapshot/cutoff üzerinden iki seçimi verir.
  `lib/cognitive-lab-m3-experiment.js` mevcut native kayıtları/oracle'ı okur;
  görevleri çalıştırmaz, terfi etmez ve gerçek bağımsızlık denetimi yapmaz.
  `lib/cognitive-lab-m3-evaluator.js` aile ortalamalarını değerlendirir.
  Yeni bir seçim motoru, journal veya bootstrap uygulanması planlanmıyor.
- Gerçek Coder kullanan entegrasyon testleri yürütme bağlantısının kanıtıdır.
  Test fixture'ları bağımsız gerçek görev corpus'u olarak kabul edilmez.

Bu planda kabul edilmiş gerçek aile sayısı bildirilmez: köken/split/oracle
envanteri henüz denetlenmedi. Sayı eksikliği yeni ID üreterek giderilmez.

## 2. Gerçek görevlerin alınması

İlk sonraki teslim, sonuç çalıştırmadan aday envanteri ve ret gerekçeleridir.
Kaynak havuzu, tarih ve seçim kuralı A1/A2 sonuçlarına bakılmadan sabitlenir.
Corpus sorumlusu ile bağımsız denetçinin gerçek kimlikleri kaydedilir;
aynı kişinin iki etiketi bağımsız inceleme sayılmaz.

| Aday kökeni | İstenen kanıt | Kabul sınırı |
| --- | --- | --- |
| Gerçek kullanıcı/operatör görevi | Asıl gereksinim, izinli kaynak bağlantısı, depo ve görev öncesi SHA | Çözüm veya oracle görev girdisine taşınmaz; özel içerik izinsiz yayımlanmaz. |
| Bağımsız depodaki gerçek bakım/hata görevi | Issue kökeni, görev öncesi artefakt, bağımlılıklar, erişim/lisans kaydı | Aynı düzeltmenin çatalları, kopyaları ve varyantları ayrı aile sayılmaz. |
| Daha önce incelenmiş HUQAN issue/PR'si | Önceden görülme ve ortak köken kaydı | İncelenen çözüm yeni holdout değildir; yalnız geliştirme/qualification adayı olabilir. |
| Sentetik fixture, yeniden koşu, üretilmiş artefakt | Üretim/ancestor ilişkisi | Altyapı tanısı için saklanabilir; gerçek bağımsız aile kotasına eklenmez. |

Her aday için şu bilgiler birlikte tutulur: köken bağlantısı ve sabit SHA,
gereksinim, görev öncesi dosya hash'leri, ancestor/türetim ilişkileri,
workspace, bağımlılıklar, source/qualification/evaluation tahsisi,
holdout/transfer alt grubu, desteklenen Coder yolu, ayrı oracle referansı,
denetçi kararı ve gerekçesi. Bunlar yeni bir runtime şeması tanımı değildir.

Yalnız mevcut desteklenen yolu gerçekten kullanabilen görevler alınır.
Bugünkü native kanıt bağlantısı sınırlı `replace_text` görevlerini doğrular;
bu, her gerçek yazılım gereksiniminin çözülebildiğini göstermez.
Gereksinimi yetkili göreve çevirme adımı cevap metnini oracle'dan alıyorsa
örnek reddedilir. Bu köprü kanıtlanamıyorsa eksik yetenek olarak kaydedilir;
testi geçmek için gizli çözüm girdisi veya yeni yorumlayıcı eklenmez.

## 3. Aile ve split denetimi

1. Source, qualification ve evaluation arasında ortak artefakt, türetim,
   çözüm kökeni ve ancestor ilişkilerini çıkar. Anlamsal köken incelemesini
   yalnız farklı dosya hash'lerine indirgeme.
2. Birbirine bağlı görevleri tek aileye birleştir. Bir ailenin tekrarları,
   farklı çalışma dizinleri ve değişen ID'leri örneklem sayısını artırmaz.
   Evaluation'daki holdout ve transfer ailelerini de birbirinden ayır.
3. En az 24 bağımsız holdout ve ayrıca 8 bağımsız transfer ailesi gerekir.
   Kaynak/qualification aileleri bu sayılara dahil edilmez. Bu alt sınır
   güç analizi veya genellenebilirlik garantisi değildir.
4. Mevcut derleme kapısı olan en az üç bağımsız olumlu destek ve 0,8
   tutarlılık korunur. Negatif destekten olumlu çalıştırılabilir yöntem çıkmaz.
5. Tam dependency evrenini iki kol için ortak kilitle. Seçilmeyen bir
   köprü epizodu çıkararak kaynakları bağımsız göstermeye çalışma.

Denetçi uygun kaynak havuzunun 32'yi aşıp aşmadığını ve seçim müdahalesinin
etkisiz kalma riskini önceden kaydeder. K=32 altında aynı kümeler seçilirse
eşik/bütçe değiştirilmez. Sonuçlara bakıp görev değiştirmek, aile elemek veya
başka seed denemek yasaktır; yeni corpus gerekiyorsa ayrı revizyon gerekir.

## 4. Oracle ve deney öncesi kilit

Oracle, görev gereksinimine göre ve seçim/yürütme kodundan bağımsız hazırlanır;
beklenen dosya hash'leri, güvenli ret durumları ve izinli değişiklik yüzeyi
ayrıca gözden geçirilir. A1/A2 adaylarını veya son çıktıları görerek oracle
düzeltilmez. Oracle'ın doğru cevabı kaynak, qualification, PE/RPE veya görev
girdisine geri beslenmez. Kuratör oracle'ı görürse bu erişim açıkça kaydedilir;
kör değerlendirme veya bağımsızlık iddiası kendiliğinden oluşmaz.

İki ayrı zaman noktası vardır:

- **Çalıştırma öncesi:** kaynak/çalıştırıcı/protokol SHA'ları, corpus kökenleri,
  split/aile listeleri, girdi ve bağımlılık hash'leri, oracle, cutoff, K,
  kol sırası/seed, test komutları, süre sınırları ve maliyet toplama yöntemi
  ayrı imzalı ve bağımsız gözden geçirilmiş kayıtla dondurulur.
- **Çalıştırma sonrası:** native run kimlikleri, seçilmiş prosedürler, kabul ve
  rollback kanıtları ile gerçek sonuç hash'leri eklenir. Mevcut Lab isteğinin
  `records` ve `lockHash` alanlarını sonradan üretmek ilk kilidin yerine geçmez.

Mevcut `protocolHash`, aile değerlendirme sözleşmesinin UTF-8/LF SHA-256
özetidir; corpus dosyalarının hash'leri gerçek baytları bağlar. İmzalı kayıt
tek başına bağımsız zaman otoritesi veya anlamsal bağımsızlık kanıtı değildir.
Gözden geçirenin sonucu görmeden yaptığı inceleme ve kilidin yayımlanma
sırası ayrıca doğrulanmalıdır. Sıra kanıtlanamıyorsa ön-kayıtlı H1 iddiası yoktur.

## 5. Eşit yürütme ve sonuçların okunması

A1 recent-K ve A2 priority; aynı workspace/snapshot/cutoff, K=32 ve tam
dependency evrenini kullanır. Her iki kolun izole çalışma/journal kopyaları
ve aynı gerçek approval, promotion/canary, admission, bağımsız kabul testi,
Coder ve rollback yolu olmalıdır. Replay çıktısı otomatik kabul yetkisi değildir.

Mevcut B4 seed=3310, resamples=2000, confidence=0,95, meaningfulEffect=0,
minimumSamples=24, minimumTransfer=8 ve wrongWriteTolerance=0 korunur.
Ön-kayıttaki kol sırası dengelenir; cold/warm ve makine yükü kaydedilir.
Eğitim/seçim/derleme/qualification/kabul/yürütme/rollback dahil gerçek süre,
process/search sayıları toplanır. Eksik CPU/bellek/maliyet `NOT_MEASURED` kalır.
Mevcut M3 okuyucusunun maliyet topladığı varsayılmaz.

Önce tüm retler, aday çıkmaması, timeout, kısmi sonuçlar ve başarısız kabul
denemeleri envanterde korunur. Eksik native kanıt geçerli örneklerden sessizce
silinmez. Herhangi koldaki güven ihlali önce `REJECT`; eksik kanıt/aile veya
etkisiz seçim `INSUFFICIENT` üretir. Farklı seçimlerin eşit doğruluğu sıfır etki
olabilir; iki kolun aynı seçimi ise müdahale etkisi kanıtı değildir.

Salt okunur değerlendirme için var olan giriş yeniden kullanılır:
`node bin/huqan-cognitive-lab.js m3 --m3-records <onaylı-istek-yolu>`.
Bu komut yeni görev koşmaz. Bu planda çağrılmadı ve henüz H1 corpus'u yoktur.
Sonuç, final kabul edilen source/procedure hash'i ve tam rollback zincirine
bağlanır; yalnız `step.ok` başarı sayılmaz. Restart sonrası aynı kabulün
kullanımı ve önceki beceri kontrolleri ayrıca korunur.

## 6. Teslim sırası ve durma ölçütleri

| Sıra | Ayrı onaylanacak teslim | Geçiş kanıtı |
| --- | --- | --- |
| 1 | Gerçek aday envanteri, aile kökenleri ve ayrı oracle taslağı | Bağımsız denetçi kabul/ret gerekçeleri; cevap sızıntısı yok. |
| 2 | Corpus/split/oracle ve çalıştırma protokolünün ön kilidi | 24+8 bağımsız evaluation ailesi, ayrı kaynak/qualification, kaynak SHA ve kilit sırası doğrulanmış. |
| 3 | Onaylı iki kollu native yürütme | Aynı kapılar/bütçe, değişmeyen kaynaklar, gerçek ölçüm ve tüm başarısız denemeler kayıtlı. |
| 4 | Mevcut okuyucuyla yeniden değerlendirme ve ayrı rapor | Aile düzeyinde sonuç/aralık, yanlış yazma, maliyet, restart ve eksik kanıt sınırları görünür. |

Her teslim kendi dosya/yürütme kapsamı için onay gerektirir. Görevler mevcut
Coder'a uygun değilse, oracle sızıyorsa veya bağımsızlık/kilit kanıtlanamıyorsa
deney başlamaz; engel #4465 altında açık kalır. Başarısız sonuç olumlu rapora
çevrilmez. Bu plan #4465'i veya G3'ü kapatmaz.

Mevcut hazırlık raporu `assertsGain:false`, `registered:false`,
`CANDIDATE_ONLY` döndürmeye devam eder; `clearsEffect` yalnız tanıdır.
Gerçek H1 bulgusu olsa bile genel öğrenme, birleşik G3 kabulü, yeni varsayılan
veya model yeteneği iddiasına dönüştürülemez. Modül kazanımları toplanmaz;
diğer ajanların mevcut G3 sonuçları yeniden etiketlenmez.

Bu dokümanın kabulü: yalnız bu dosya değişmiş olmalı; bağlantılar mevcut
kaynaklara çözülmeli; ön-kayıt sabitleri korunmalı; `git diff --check` ve
`node scripts/check-docs-drift.js` geçmeli. Runtime veya H1 testi bu belge
değişikliğini doğrulamak için tekrar çalıştırılmaz.
