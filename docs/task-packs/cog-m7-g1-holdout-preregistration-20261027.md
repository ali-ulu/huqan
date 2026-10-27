# M7 / G1 bağımsız görev ölçümü: ön-kayıt kilidi

Durum: **KİLİTLİ — sahip onayı 2026-10-27** (sentetik etiketli corpus, |Δ| = 0.15 ve
32-64 grup, iki yönlü hipotez). Metin bu imzalı commit ile sabitlenir. Runner PR'ı
manifest digest'ini alır, holdout ancak ondan sonra koşulur. Sonuçlar bu belgeye
eklenmez; ayrı rapor/PR ile verilir. Herhangi bir değişiklik yeni sürüm gerektirir.

**Sürüm 2 (2026-10-27, holdout açılmadan önce):** aşağıdaki §11, incelemede açık
kalan on bir kilidi kapatır (onay akışı, kontrol kol enjeksiyonu, bölme denetimi
sınıflaması, σ̂ kuralı, bütçe/görev sayım protokolü, kuyruk karıştırma,
non-inferiority alt tabakası ve boş-alt-tabaka durumu, etiket kapsayıcılığı, tek-tür
anti-vaka). Ölçüm tasarımının özü (|Δ| = 0.15, 32-64 grup, iki yönlü hipotez)
değişmedi; yalnız prosedür netleşti.

**Sürüm 3 (2026-10-27, runner ile, holdout ve calibration açılmadan önce):** §12,
runner uygulamasında çıkan beş kilidi kapatır (iki aileli grup, `maxSteps = 4`,
iki kolda aynı kayıt önyüklemesi, tek salt-okunur kaynak depo, train geçmişiyle
uyumlu mutasyon ölçütü). Hipotez, etki,
N formülü ve karar kuralları değişmedi.

İlgili iş: #4065 (G1 sahibi), epic #4060. Plan: `docs/cognitive-architecture-plan.md` §7 G1
son maddesi ("ölçülen düzelme, dondurulmuş ve öğrenmede kullanılmayan bağımsız
görevlerde doğrulanır"). Önceki taslak: `cog-m7-salience-preregistration-20261022.md`;
bu belge onun "Holdout öncesi açık kilitler" tablosunu doldurur, onu değiştirmez.

## 1. Kaynak ve kollar

- Aday kaynak SHA: `f626370538cb59c586f9b0b462f1039488f2c07c` (#4350 sonrası main).
  Ölçüm runner'ı ayrı PR'la eklenir; birleştiği SHA manifestte ayrıca sabitlenir.
  Runner dışında üretim kodu ölçüm sırasında değişmez.
- Giriş: üretim HTTP yolu. Bir görev önce `POST /api/v2/agent/coder/cases` ile
  kuyruklanır (#4346), sonra `POST /api/v2/agent/coder/cases/{caseId}/decision` ile
  onaylanır ve `POST /api/v2/agent/coder/runs` ile yürütülür (#4348). Tüm çağrılar
  `cognition: true` taşır; gerçek Coder yürütmesi, gerçek oversight runtime, gerçek
  journal kullanılır.
  - **Onay ayrı kimliktir.** Kararı taşıyan anahtar, taşıma anahtarı değildir:
    `.../decision` ek olarak `x-huqan-operator-capability` başlığında kapsam-bağlı
    bir operatör yetkisi ister (#3926; `lib/http/workflow-decision-gate.js`). Yetki
    yoksa uç 403 `OPERATOR_AUTH_REQUIRED` döner. Runner dört onaylı görevi bu yolla
    kurar; aynı anahtarla önerip onaylayamaz.
- **Aday kol:** mevcut M7 (salience → scheduler urgency).
- **Kontrol kol:** aynı SHA, aynı gözlem/öğrenme/ödül akışı; yalnız scheduler'a giden
  `urgency` sıfırlanır (Lab mekanizması `lib/cognitive-lab-m7-runtime.js:51`).
  Cognition'ı kapatmak kontrol değildir: gözlemi de kapatır.
- **Kontrol kolun HTTP sürecine enjeksiyonu.** Lab kolu in-process çalışır: `runArm`
  `Module._load`'u yamalar, sonra `require('../agent.v3')` yükler (`:91-95`) — ayrı
  bir HTTP süreci bundan etkilenmez. Runner bu yüzden kontrol kolunu, ölçüm
  sürecini üretim HTTP girişiyle başlatırken `--require` ile bir **arm önyükleme
  modülüyle** açar (Node `-r`/`--require`; mekanizma `scripts/a2a-error-depth-mutation.js:40`
  ile aynı sınıf). Önyükleme modülü yalnız `lib/agent-cognition-seam.js` →
  `lib/agent-step-progression.js` sınırındaki `scheduleQueuedSteps` sarmalayıcısını
  kurar ve `urgency` alanlarını sıfırlar; kaynak puanlama, algılama ve geçmiş
  çalışmaya devam eder. Aday kol için önyükleme modülü yoktur.
  - Runner her koşuda seçili kolu, önyükleme modülünün içerik digest'ini ve
    normalleştirilmiş scheduler girdilerini kaydeder. Normalleştirme, yalnız
    `urgency` farkı kalacak biçimde yapılır (Lab `normalize()` ile aynı: izole
    workspace'e bağlı türetilmiş kimlikler `<isolated-id-or-clock>` olur). İki kolu
    `urgency` dışında bir alanda ayrışan koşu **reddedilir** (INSUFFICIENT).
- İki kol her epizotta aynı başlangıç graf/journal kopyasından, ayrı workspace ve depo
  kopyalarıyla başlar; bir kolun yazısı diğerine veya sonraki epizoda taşınmaz.

## 2. Hipotez (iki yönlü)

H1: Eşit görev bütçesinde M7 urgency katkısı, epizot başına bağımsız kabulü geçen
görev oranını kontrolden **farklı** kılar.

Yön önceden iddia edilmez. M7, başarısız bir iş türüne dikkati artırır ve aynı türden
sonraki görevi öne alır. Başarısızlıklar türe göre kümeleniyorsa bu, başarı oranını
**düşürebilir**. Zarar da kazanç kadar raporlanır.

## 3. Görev corpus'u

Gerçek repolardan yeterli Coder görevi bugün yoktur. Coder yalnız `initialize_project`
ve `replace_text` yürütür. Bu ölçüm bu yüzden **sentetik kontrol corpus'u** ile yapılır
ve sonucu "G1 sentetik ölçümü" olarak etiketlenir. G3 ayrıca gerçek görev corpus'u
ister; bu ölçüm onun yerine geçmez.

- Görev türü: `initialize_project`, arşetip `node_computed_json_api`, aileler
  `lib/coder/project-compute.js` `FAMILIES` (array-fold, array-guarded-fold,
  array-threshold-fold, array-stateful-fold, array-map, array-filter).
- **Grup:** bir (aile, hedef fonksiyon) çifti. Hedef fonksiyon seed'li üreteçten çekilir.
  Aynı fonksiyondan türetilen varyantlar aynı gruptadır.
- **Doğal başarısızlık:** sentez yalnız `examples`'tan program çıkarır. Kabul,
  `acceptanceExamples`'ta (ayrı girdiler) bağımsız denetlenir. Örneklere uyan ama yanlış
  genelleyen program gerçek `contradiction` üretir. **Hata enjekte edilmez**: kabul
  örnekleri hedef fonksiyonun gerçek çıktısıdır.
- Her grubun spec'i, hedef fonksiyonu ve kabul girdileri içerik digest'iyle manifestte yer alır.

## 4. Bölme ve sızıntı

- Üreteç seed'i `20261027`. Gruplar sırayla **train** (8), **calibration** (8) ve
  **holdout** (N, §6) bölmelerine atanır.
- Aynı (aile, fonksiyon) ya da aynı digest iki bölmede bulunamaz. Runner bunu koşudan
  önce denetler. **Denetleyici çalışamazsa** (manifest okunamaz, digest hesaplanamaz)
  sonuç INSUFFICIENT'tır; **denetleyici çalışıp sızıntı bulursa** sonuç REJECT'tir
  (§7, fail-closed). İki durum ayrı raporlanır.
- **Train:** başlangıç geçmişi. Her tür için `DEFAULT_SUMMARY_WINDOW − 1` gerçek Coder
  sonucu bir kez üretilir ve donmuş snapshot olur.
- **Calibration:** yalnız kurulum, süre, doğal başarısızlık oranı ve σ tahmini içindir.
  Sonucu gain sayılmaz. Calibration grupları holdout gruplarıyla **aynı epizot
  yapısını, bütçeyi ve `[1, 2, 3]` seed listesini** kullanır (§5); tek fark sonucunun
  gain sayılmamasıdır.
- **Holdout:** yalnız bir kez koşulur. Önceden açılmaz.

## 5. Epizot, bütçe ve politika

- Bir epizot bir holdout grubunun iki türünden 4 onaylı görevdir (her türden 2).
  Kuyruk sırası epizot seed'iyle karıştırılır.
  - **Karıştırma (shuffle) prosedürü sabittir.** PRNG `mulberry32`'dir
    (`lib/cognitive-lab-paired-delta.js:155`). Bir (grup, seed) çifti için karıştırma
    tohumu `shuffleSeed = (groupDigest mod 2^32) XOR seed`, burada `groupDigest`
    grubun manifestteki 64 bitlik digest'inin ilk 8 hex basamağıdır. 4 görev bu
    tohumla Fisher-Yates ile karıştırılır. Runner bu prosedürü uygular; sıra
    deterministiktir ve manifestteki grup digest'iyle yeniden üretilebilir.
- **Bütçe adım birimindedir; API görev saymaz.** `POST .../runs` yalnız `maxSteps` ve
  `maxIterations` alır, görev sayacı almaz (`lib/http/agent-coder-routes.js:249`);
  yanıt per-case tamamlanma durumu vermez, yalnız adım özetleri (`{id, tool, status,
  error}`) döner (`:253-257`). Runner protokolü bu yüzden şöyledir:
  - Epizot başına 4 onaylı görev **tek** `runs` çağrısıyla kuyruklanır;
    `maxSteps = maxIterations = 2`. Her Coder eylemi bir adımdır, böylece en çok 2
    görev yürür ve kuyruk sırası — yani M7'nin etkisi — belirleyici olur. Her iki kol
    aynı değerleri kullanır.
  - **Tamamlanma tespiti.** Runner elindeki `caseId → görev` eşlemesiyle her dönen adımı
    `tool` alanından bir göreve bağlar. Bir görev *yürütülmüş* sayılır ancak ve ancak
    onun adımı yanıtta `status: completed` ile görünürse; başarı ayrıca bağımsız
    `acceptanceExamples` denetimiyle doğrulanır (§3).
  - **Yeniden gönderme.** Bir adım bir görevi tamamlamadan tüketilirse (adım hatası),
    runner aynı `caseId` ve workspace ile görevi yeniden gönderir; görev durumu
    workspace'te korunur. Epizot başına adım üst sınırı `maxEpisodeSteps = 6`; bu
    sınırda hâlâ tamamlanmayan görev başarısızdır. Protokol iki kolda da aynıdır.
- **Yürütülmeyen görev kuralı.** Bir epizotta onaylı bir görev bütçe nedeniyle hiç
  yürütülmezse, o görev **başarısızlık** sayılır ve paydada kalır (zaman aşımı
  kuralıyla aynı, §5 son madde). Payda her epizotta sabit 4 onaylı görevdir; bu,
  başarı oranını kollar arasında karşılaştırılabilir tutar.
- **Politika:** epizotlar arası taşıma yoktur. Her epizot donmuş train snapshot'ından
  başlar. Epizot içinde M7'nin çevrimiçi uyarlaması serbesttir, ölçülen mekanizma budur.
- Seed listesi: `[1, 2, 3]`. Her holdout grubu 3 seed'le koşulur. Grup skoru 3 seed'in
  ortalamasıdır; seed'ler bağımsız örnek sayılmaz.
- Görev başına Coder zaman aşımı mevcut varsayılandır. Aşım başarısızlıktır; paydadan
  çıkarılmaz.

## 6. Ölçü, etki ve örnek sayısı

- **Birincil ölçü:** grup başına (aday başarı oranı − kontrol başarı oranı). Başarı,
  onaylı görevin bağımsız kabulü geçmesidir; payda her epizotta sabit **4 onaylı
  görevdir** (§5). Yürütülmeyen veya zaman aşımına uğrayan görev başarısızlıktır.
  Adım seçimi, `step.ok` veya kuyruk sırası başarı değildir.
- **Asgari anlamlı etki:** |Δ| = 0.15 (epizottaki 4 onaylı görevden ortalama 0.6 görev farkı).
- **Örnek sayısı:** `N = clamp(ceil(((1.96 + 0.84) · σ̂ / 0.15)²), 32, 64)` holdout grubu.
  σ̂, calibration'daki 8 grup farkının **örneklem** standart sapmasıdır (**n − 1**
  paydası; α = 0.05 iki yönlü, güç 0.80). Popülasyon (n) tahmincisi kullanılmaz; 8
  grupta fark `ceil` sonucunu ve dolayısıyla N'i değiştirir. Calibration grupları
  holdout ile aynı epizot yapısını, bütçeyi ve `[1, 2, 3]` seed listesini kullanır
  (§5). N calibration bittikten ve holdout açılmadan önce bu formülle hesaplanır,
  manifestte kilitlenir ve sonradan değişmez.

## 7. Karar kuralları

- **Belirsizlik:** grup farkları üzerinde %95 eşli bootstrap güven aralığı
  (10.000 tekrar, seed `20261027`). Destekleyici olarak işaret testi raporlanır.
- **Eski beceri non-inferiority:** alt tabaka **tedavi öncesi** tanımlanır: holdout
  grupları, epizot açılmadan önce, train snapshot'ındaki ilgili türde doğal
  başarısızlık gözlenmeyen gruplar olarak işaretlenir (manifestte sabitlenir). Bu alt
  tabakada aday, kontrolden en fazla 0.05 daha düşük olabilir (GA alt sınırı > −0.05).
  Alt tabaka hiçbir koşuda aday/kontrol sonucuna göre yeniden seçilmez; sonuç
  görüldükten sonra tanımlanırsa kontrol keşifsel sayılır ve GAIN koşulu olmaktan çıkar.
  - **Boş alt tabaka.** Alt tabaka boşsa ya da manifestte calibration'dan önce
    sabitlenen asgari grup sayısının (`minStratumGroups`, varsayılan 8) altındaysa
    non-inferiority değerlendirilemez. Bu durumda **GAIN verilmez**. GA aralığı yine
    raporlanır ve etiket GA'ya göre seçilir: GA üst sınırı < 0 → ZARAR, GA 0'ı içerir →
    MEASURED_NO_GAIN, GA alt sınırı > 0 → MEASURED_GATE_FAIL; gerekçe "non-inferiority
    değerlendirilemedi" olarak yazılır. Bu durum INSUFFICIENT'a eşlenmez, çünkü
    INSUFFICIENT zarardan önceliklidir ve ölçülmüş zararı gizlerdi.
- **Maliyet:** model ve ağ çağrısı 0. Epizot duvar süresi medyanı kontrolün 1.5 katını
  aşmaz. Bellek ve Coder çağrı sayısı ayrı raporlanır.
- **Etiketler (her geçerli sonuç tam olarak bir etiket alır; öncelik sırası yukarıdan
  aşağıdır):**
  1. **REJECT:** yetki/onay bypass'ı, workspace sızıntısı, yanlış tamamlandı bildirimi
     veya bölmeler arası **tespit edilmiş** sızıntı. Ortalama artış bunu telafi etmez;
     diğer tüm etiketlerin önüne geçer.
  2. **INSUFFICIENT:** kurulum hatası, N'ye ulaşılamaması, bölme **denetleyicisinin
     çalışamaması** (§4) veya kol girdilerinin `urgency` dışında ayrışması (§1).
  3. **ZARAR (harm):** geçerli deney, GA üst sınırı < 0. Bu etiket kazançtan bağımsız
     olarak raporlanır.
  4. **GAIN:** GA alt sınırı > 0 **ve** non-inferiority **ve** maliyet geçer.
  5. **MEASURED_NO_GAIN:** geçerli deney, GA 0'ı içerir (zarar yok).
  6. **MEASURED_GATE_FAIL:** geçerli deney, GA alt sınırı > 0 ama non-inferiority
     veya maliyet geçmez. Bu durumda etki pozitif olsa da etiket GAIN değildir ve
     hangi kapının düştüğü yazılır.
  - Not: 3 ile 4 çelişmez (zarar GA üst sınırı < 0; GAIN GA alt sınırı > 0). 6, pozitif
    ama kapıyı geçmeyen sonucu kapsar; böylece geçerli her sonuç tek bir etiket alır.
- Hiçbir etiket üretim varsayılanını kendiliğinden değiştirmez (cognition opt-in kalır).

## 8. Anti-vakalar ve mutasyon

- Önceden seçilen anti-vakalar (hepsi **calibration** bölmesinde ayrı fixture'dır;
  holdout epizotları §5'in iki-tür×iki-görev yapısına uyar):
  - hiç başarısızlık olmayan epizot,
  - iki türün de başarısız olduğu epizot,
  - tek türden oluşan epizot (yalnız calibration fixture'ı; §5 normal yapısından
    açık istisna).
  Adayın bunlarda kaybetmesi şart değildir. Bütünlük ve doğruluk denetlenir.
- Gözlem bağlantısını kesen mutasyon (`observeAcceptance → null`) holdout'tan önce
  calibration'da bir kez koşulur. Aday kol kontrolle aynı seçimleri yapmalıdır; yapmazsa
  runner geçersizdir (INSUFFICIENT).

## 9. Kilit tablosu (önceki taslaktaki açık maddeler)

| Kilit | Bu belgedeki karşılığı |
| --- | --- |
| Aday ve kontrol SHA'ları | §1 (aday SHA; runner SHA'sı birleşince manifestte) |
| Yalnız urgency farkı kontrolü | §1 kontrol kol + HTTP önyükleme enjeksiyonu + §8 mutasyon |
| Görev corpus'u, gruplar, digest'ler | §3 (sentetik; digest'ler manifestte) |
| Bölmeler ve sızıntı denetimi | §4 (denetleyici çalışamaz → INSUFFICIENT; tespit → REJECT) |
| Holdout politikası | §5 (epizotlar arası donmuş, epizot içi çevrimiçi) |
| Kabul oracle'ları ve yürütme yolu | §3 bağımsız `acceptanceExamples`, §1 HTTP yolu + onay yetkisi |
| Bütçe, seed, durdurma | §5 (bütçe birimi görev; shuffle prosedürü; yürütülmeyen görev = başarısızlık) |
| Asgari etki, güç, grup sayısı | §6 (σ̂ = örneklem s.d., n − 1) |
| Non-inferiority ve maliyet sınırları | §7 (alt tabaka tedavi öncesi tanımlı) |
| Belirsizlik yöntemi, eşikler, evaluator | §7; evaluator sürümü runner PR'ında |

## 10. İddia sınırı

Bu ölçüm, sentetik ve model kullanmayan Coder görevlerinde M7'nin seçim etkisini ölçer.
Gerçek mühendislik görev başarısını, G2/G3 kabulünü veya genel öğrenme kazancını kanıtlamaz.

## 11. Sürüm 2: incelemede açık kalan kilitler

Holdout açılmadan önce, ilk sürümün incelemesinde çıkan açık noktalar bu bölümle
kapatılır. Tablo, her maddenin hangi bölümde karara bağlandığını gösterir.

| # | Açık nokta | Karşılığı |
| --- | --- | --- |
| 1 | Onay akışı eksik: `.../cases/{caseId}/decision` ve ayrı onay kimliği yazılmamış | §1 (decision ucu + `x-huqan-operator-capability`, 403 `OPERATOR_AUTH_REQUIRED`) |
| 2 | Kontrol kolun üretim HTTP sürecine enjeksiyonu tanımsız | §1 (`--require` arm önyükleme modülü; arm + digest + normalleştirilmiş girdi kaydı) |
| 3 | §4 (ihlal → REJECT) ile §7 (denetim → INSUFFICIENT) çelişkisi | §4 ve §7 (denetleyici çalışamaz → INSUFFICIENT; tespit → REJECT) |
| 4 | σ̂ tahmincisi (n vs n − 1) ve calibration epizot şekli belirsiz | §6 (n − 1 örneklem s.d.; calibration holdout ile aynı yapı/seed) |
| 5 | `maxIterations: 2` = "2 görev yürür" varsayımı yanlış; yürütülmeyen görev kuralı yok | §5 (bütçe adım birimi; yürütülmeyen görev başarısızlık, paydada kalır) |
| 6 | Kuyruk karıştırma PRNG/eşleme/algoritma tanımsız | §5 (`mulberry32`; `(groupDigest XOR seed)`; Fisher-Yates) |
| 7 | Non-inferiority alt tabakası tedavi sonrası tanımlı | §7 (alt tabaka tedavi öncesi, train metadata'sından, manifestte sabit) |
| 8 | Etiketler kapsayıcı değil (zarar/pozitif-ama-kapı-düşük sonuçlar) | §7 (öncelikli, tam kapsayıcı etiket kümesi) |
| 9 | §8 tek-tür anti-vakası §5 iki-tür yapısıyla çelişiyor | §8 (anti-vakalar ayrı calibration fixture'ı) |
| 10 | `maxExecutedTasks` gerçek API'de yok; görev tamamlanma tespiti tanımsız | §5 (`runs` protokolü: `maxSteps = maxIterations = 2`, adım→görev eşleme, `status: completed`, `maxEpisodeSteps` ile yeniden gönderim) |
| 11 | Boş non-inferiority alt tabakası etiketsiz kalıyor | §7 (boş/az alt tabaka: GAIN yok; etiket GA'ya göre ZARAR / MEASURED_NO_GAIN / MEASURED_GATE_FAIL, INSUFFICIENT'a eşlenmez) |

Bu bölüm yeni bir ölçüm tasarımı getirmez; §1-§8'deki prosedürü kilitler.

## 12. Sürüm 3: runner uygulamasında çıkan kilitler (2026-10-27, holdout açılmadan önce)

Runner yazılırken ve ilk calibration denemesinde kilitli metinde uygulanamayan veya
ölçümü tasarım gereği etkisiz kılan beş nokta çıktı. Her biri holdout açılmadan, calibration'dan önce sahip onayıyla
(2026-10-27) karara bağlandı. Hipotez, etki büyüklüğü, N formülü, seed'ler, karar
kuralları ve etiketler değişmedi.

| # | Kilitli metin | Sorun | Karar |
| --- | --- | --- | --- |
| 1 | §3 grup = bir (aile, hedef fonksiyon); §5 epizot = "grubun iki türünden" 4 görev | Tür (`workKind`) aileye bağlıdır (`initialize_project:<aile>`); tek aileli bir grubun iki türü olamaz | **Grup, iki farklı aileden birer (aile, hedef fonksiyon) biriminden oluşur.** Her türün 2 görevi aynı hedef fonksiyonun farklı örnek setli varyantıdır. Bölme denetimi birim anahtarı, birim digest'i ve grup digest'i üzerinde yapılır. İlk üç grup aileler üzerinde tam eşleşmedir; böylece train geçmişi her türü kapsar. |
| 2 | §5 `maxSteps = maxIterations = 2` | `POST .../runs` içinde `maxSteps` planı sınırlar: scheduler 4 onaylı görevden yalnız kuyruğun ilk 2'sini görür ve ikisini de yürütür; M7 hangi görevin koşacağını değiştiremez (ölçüm tasarım gereği sıfır etki verir) | **`maxSteps = 4` (bütün onaylı kuyruk planlanır), `maxIterations = 2` (2 görev yürür).** Mevcut G1 HTTP testi (`g1Arm`) de bu biçimdedir. `maxEpisodeSteps = 6` değişmedi. |
| 3 | §1 "aday kol için önyükleme modülü yoktur" | Normalleştirilmiş scheduler girdisinin iki kolda kaydedilip karşılaştırılması (§1) ancak iki kolda da aynı kayıt noktasıyla mümkündür | **İki kol da aynı önyükleme modülünü yükler** (`lib/cognitive-lab-g1-arm-preload.js`). Aday kolda modül yalnız kaydeder; kontrol kolda ayrıca `urgency`'yi 0 yapar. Modül iki kolda model/ağ çağrısını sayar ve reddeder (§7 maliyet). Normalleştirme Lab listesine `runId`'i ekler (her süreçte yeni üretilen izole koşu kimliği). |
| 4 | §1 "ayrı workspace ve depo kopyaları" | Cognition çerçevesi kaynak deponun yolunu ve HEAD'ini bağlar; kollar farklı kaynak yolu kullanırsa train geçmişi eşleşmez ve M7 hiç sinyal görmez | **Kaynak depo tek, sabit ve salt okunurdur** (sabit commit tarihi). Kollar arasında ayrılan şey Coder'ın yazdığı hedef dizinleri ile graf/journal kopyasıdır; her epizot donmuş train snapshot'ının taze kopyasından başlar. |
| 5 | §8 mutasyon: gözlem kesilince "aday kol kontrolle aynı seçimleri yapmalıdır" | §4/§5 her epizodu donmuş train geçmişinden başlatır; bu geçmiş M7'ye ilk seçimde, hiçbir epizot içi gözlemden önce sinyal verir (ilk calibration denemesi: stateful-fold 0.138 / fold 0.103). Gözlem kesik aday, kontrolden tasarım gereği farklı seçer; kontrol her zaman düşer ve N hiç kilitlenmez | **Yeni ölçüt:** gözlem kesikken adayın her görevdeki `urgency`'si epizot boyunca ilk seçimdeki (geçmişten gelen) değerinde donmuş kalmalı; gözlem açıkken en az bir calibration epizodunda değişmeli. İkisi birden sağlanmazsa INSUFFICIENT. Kontrolle aynı seçim yapılıp yapılmadığı raporlanır ama kapı değildir. İlk denemede gözlem açık 24/24 epizotta değişti, gözlem kesikken dondu. |

Uygulamaya ait gözlemler (tasarım değişikliği değildir):

- **Bağımsız kabul oracle'ı:** runner, Coder'ın kendi raporuna değil, üretilen
  `src/logic.js` modülünün kabul satırlarındaki çıktısına bakar. Coder'ın `done`
  dediği ama oracle'ın reddettiği görev "yanlış tamamlandı bildirimi"dir → REJECT.
- **Yeniden gönderme:** onay tek yürütmeyi rezerve eder; aynı `caseId` ikinci kez
  `approval.execution_already_reserved` ile engellenir. Proje başlatma tek adayını
  test eder; kabulü geçmeyen görev `ALL_CANDIDATES_EXHAUSTED` ile biter ve
  başarısızdır. Yalnız bunların dışındaki adım hataları yeniden gönderilir.
- **Bütçe adım birimindedir (§5):** üretim ajanının koşu başına varsayılan duvar
  süresi bütçesi (`timeBudgetMs = 30000`, `agent.v3.js`) yavaş makinede ikinci adımı
  kesiyordu: ilk calibration denemesinde bazı epizotlar 2 yerine 1 görev yürüttü ve
  sonuç makine hızına bağlandı. Runner'ın ajan kurucusu (host ayarı, üretim kodu
  değil) koşu bütçesini 10 dakikaya çıkarır; bağlayıcı sınır yalnız
  `maxIterations = 2` olur. Adım bütçesini harcamadan biten kol INSUFFICIENT nedeni
  üretir.
- **Kol sırası:** her (grup, seed) çiftinde önce koşan kol seed'in tekliğine göre
  değişir (tek: kontrol önce, çift: aday önce); sıcak önbellek duvar süresi
  oranını (§7 maliyet) hiçbir kola kaydırmaz.
- **Bütünlük:** history dahil her alt süreç önyükleme altında koşar; maliyet kaydı
  eksik olan, model/ağ çağrısı yapan veya ortak kaynak depoyu değiştiren (HEAD ya
  da çalışma ağacı) kol REJECT nedeni üretir. Yarım kalmış bir history snapshot'ı
  yeniden kullanılmaz, silinip baştan kurulur.
- **Holdout ön denetimi:** holdout, tek kullanımlık işaretini (`wx`) yazmadan önce
  manifestteki corpus digest'ini, protokolü (seed'ler, bütçe), runner dosyalarının
  ve bu belgenin digest'lerini, kalibrasyon commit'inden bu yana runner dışı üretim
  kodunun değişmediğini denetler; uyuşmazlıkta holdout açılmaz. Açıldıktan sonra
  çöken koşu INSUFFICIENT olarak yazılır, yeniden denenmez.
- **Doğal başarısızlık ön ölçümü:** üretimdeki sentezci, seed 20261027, aile başına
  200 hedef, 3+3 satır: %28.9 (map %4.5 – filter %47). Oran ≈0 değildir; tasarım
  geçerlidir.
- **Non-inferiority alt tabakası:** train geçmişinde yalnız `array-fold` ve
  `array-map` hiç doğal başarısızlık göstermedi. Alt tabaka bu yüzden yalnız
  (fold, map) gruplarından oluşur ve büyük olasılıkla `minStratumGroups = 8`'in
  altında kalır. §7 kuralı **aynen korunur** (sahip kararı 2026-10-27): bu durumda
  GAIN verilmez, etiket GA'ya göre seçilir. Bu sonuç holdout'tan önce burada yazılıdır.

Runner: `lib/cognitive-lab-g1-holdout.js` (`calibrate` / `holdout`), corpus
`lib/cognitive-lab-g1-corpus.js`, karar aritmetiği `lib/cognitive-lab-g1-stats.js`,
alt süreç `lib/cognitive-lab-g1-episode.js`. Calibration manifesti, σ̂ ve kilitlenen N
ayrı dosyadadır: `docs/task-packs/cog-m7-g1-calibration-manifest-20261027.json`.
