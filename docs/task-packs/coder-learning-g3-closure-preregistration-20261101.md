# Coder öğrenme kazanımı — G3 kapanış boyutları ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Külliyat (§4), bölme (§5), metrikler (§6),
eşikler (§7) ve karar kuralları (§8) bu commit ile donduruldu. Ölçüm bu commit'ten **sonra**,
aynı PR içinde koşulur; sonuç ayrı bir belgede raporlanır
(`coder-learning-g3-closure-result-20261101.md`).

**Base:** `70099e37` (origin/main).
**Issue:** [#4470](https://github.com/ali-ulu/huqan/issues/4470).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki:** #4462 (`GAIN`, N=70, doğruluk non-inferiority + işlem maliyeti ölçüldü),
#4416 (güç + tekrarlı CPU, 10 görevlik dilim), #4380 (restart + eski-beceri, 6 görevlik dilim).

## 0. Amaç ve sınır

`docs/cognitive-architecture-plan.md` §G3 şunu ister: *"G3 bileşim, maliyet, değişen ortam,
restart ve eski beceri ölçümleri kaynak SHA/manifest ile raporlandı"* ve *"Maliyet: model/araç
çağrısı, süre ve bellek ayrı raporlanır"*. #4462 büyütülmüş mühürlü kohortta **yalnız**
doğruluk non-inferiority'sini ve işlem maliyetini kapattı; §9 kalan boyutları "ayrı ön-kayıt ve
koşumlar"a bıraktı.

Bu belge **eksik boyutları tek bir ön-kayıtlı ölçümde**, aynı gerçek mühürlü `coder
--synthesize` / `--adapt-memory` kaynağı üzerinde ölçer:

| Eksik boyut | Neden burada |
|---|---|
| Güç (`sigma` bir kalibrasyon diliminden) | #4462'de `NOT_DERIVED` (kalibrasyon dilimi yok) |
| CPU dağılımı (tekrarlı) | #4462 bu testte ölçmedi |
| Bellek / tepe RSS (tekrarlı) | hiç ölçülmedi |
| Eğitim yükü amortize toplamda | #4462'de tasarım gereği dışlandı |
| Restart sonrası kazanım | #4462 bu testte ölçmedi |
| Dağılım kaymasına uyum | #4462 bu testte ölçmedi |
| Eski-beceri non-inferiority | #4462 bu testte ölçmedi |

Sınırlar:
- #4462'nin N=70 doğruluk/işlem kanıtı **yeniden koşulmaz**; referans verilir, kopyalanmaz.
- #4416 ve #4380 dilimleri **tüketilmiştir**; bu belge kendi külliyatını dondurur, onlara atıf
  yapmaz ve onların sonucunu geçersiz kılmaz.
- Bu bir **ölçüm protokolüdür**, ölçüm değil. Runtime kodu, wiring, eşik veya varsayılan
  değişmez; `lib/` altında hiçbir dosya değişmez.
- Sentetik fixture ile doldurulmaz: kaynak yine **gerçek** `coder --synthesize` mühürlü günlük
  kaydıdır (§2). Holdout **görevleri** fixture'dır (önceki ölçümlerle aynı sınırlama, §9).
- Sonuç ne çıkarsa `GAIN` / `MEASURED_NO_GAIN` / `INSUFFICIENT` / `NOT_MEASURED` / `REJECT`
  olarak olduğu gibi raporlanır. Yönlü bir sonuç vaat edilmez.

## 1. Hipotezler

- **H0:** Eksik boyutlardan en az biri (güç, maliyet, restart, kayma, eski-beceri) kilitli
  eşiği karşılamaz **veya** ölçülemez.
- **H1 (yönlü):** Learned kol, gerçek mühürlü kaynakta, (a) kalibrasyon diliminden türeyen
  `sigma` altında holdout boyutu yeterli güçtedir, (b) duvar-saati/CPU/RSS dağılımları
  tekrarlı ölçülür ve eğitim yükü amortize toplama dahildir, (c) yeni bir süreçte restart
  sonrası öğrenilmiş aday aynı-aile görevi yine yürütür ve eligibility defteri yeniden açılışta
  korunur, (d) kaydırılmış kohortta uyum sağlanır, (e) daha önce öğrenilmiş görev seti yeniden
  koşulduğunda non-inferiority sınırı korunur.

## 2. Gerçek görev kaynağı (kanıtlanmış zincir — #4432/#4449 ile aynı)

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>   lib/cli-coder.js
  -> experience_journal: 7 hash-zincirli satır                            lib/experience/journal.js
  -> readSealedRun(journal, '<id>:c1', workspaceId)                       lib/experience/learning-intake.js
     => { ok:true, manifest.closed:true,
          learningEligibility:'positive_procedure', outcomeStatus:'verified' }
```

- Kaynak yalnız `manifest.closed === true` mühürlü koşumlardır; açık veya düzenlenmiş kayıt
  fail-closed reddedilir (`NOT_SEALED` / `INTEGRITY_MISMATCH`).
- Learned kolun her holdout/kayma/eski-beceri koşumu bu mühürlü kaydı üretir; ölçüm bunu
  görev başına doğrular (`sealedEligibility === 'positive_procedure'`).

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Aile başına taze çalışma kökü; görevler `--synthesize`, bellek yok. |
| Learned kol | Aynı görevler; aile eğitim görevi `--synthesize` + `rememberFile`, sonra `--adapt-memory`. |
| Eşit bütçe | Her iki kol `BUDGET = 8` process limiti; aynı görev hash'leri, aynı kaynak, aynı test komutları. |
| Maliyet probu | Her Node alt süreci `process.cpuUsage()` ve `resourceUsage().maxRSS` yazar (`test/helpers/coder-cpu-probe.js`); eksik/short log `NOT_MEASURED`. |

## 4. Külliyat (ölçümden önce kilitlendi)

- **Birim:** mühürlü bir synthesis koşumundan türetilen bir görev.
- **Aileler (2, bağımsız):** `arithmetic-expression` (buggy `p => p + 1`, hedef `p % 2`) ve
  `string-expression` (buggy `p.toUpperCase()`, hedef `p.trim().toLowerCase()`).
- **Kalibrasyon dilimi (yalnız `sigma`):** aile başına **3**, toplam **6** görev
  (`arith-cal-1..3`, `string-cal-1..3`). Holdout'tan ve eğitimden ayrı kimlikler.
- **Holdout:** aile başına **5**, toplam **N = 10** (`arith-h1..5`, `string-h1..5`).
- **Kaydırılmış kohort:** aile başına **2**, toplam **4** görev (`arith-shift-1..2`,
  `string-shift-1..2`). Aynı aile ve aynı hedef; **değer aralığı dağılım dışı** (arith: büyük
  büyüklükler; string: fazla boşluk ve uzun girdiler).
- **Eski-beceri seti:** **2** görev (`arith-prior-1..2`). Eğitim dağılımıyla aynı şekil;
  öğrenmeden **sonra** yeniden koşulur.
- **Eğitim görevi:** aile başına 1 (kohortta sayılmaz, bölme dışı).
- **Bağımsızlık:** görev adları ve parametreleri benzersizdir; aynı görev kimliği iki kez
  sayılmaz.
- **Anti-vaka:** `manifest.closed !== true` veya `learningEligibility` pozitif prosedür değil
  → görev kohorttan düşer (fail-closed).

## 5. Bölme ve sızıntı

- Bölmeler `train / calibration / holdout` düzeyinde ayrılır; eğitim ve kalibrasyon görev
  kimlikleri holdout'ta **görünmez** (`assert` ile kontrol edilir, `LEAK` → `REJECT`).
- Holdout hiçbir eğitim/selection adımında kullanılmaz. `sigma` **yalnız** kalibrasyon
  diliminden hesaplanır, holdout açılmadan önce.
- Kalibrasyon ve holdout aynı kaynaktan (aynı mühürlü zincir) gelir ama **ayrı görev
  kimlikleri** taşır; kayma seti de ayrıdır.

## 6. Metrikler ve yön

- **Güç:** `sigma` = kalibrasyon diliminin eşlenmiş farklarının örnek standart sapması, metrik
  başına; `requiredSample` §7 formülüyle; `powerMet = holdoutSize >= requiredSample`. `sigma`
  ölçülemezse o metrik `NOT_MEASURED` (güç iddiası yapılmaz). Güç kapısı **birincil** metrik
  (process) üzerindedir; duvar-saati/CPU/RSS gücü metrik başına raporlanır.
- **Maliyet (tekrarlı, R ≥ 3):** duvar-saati, CPU ve tepe RSS **dağılım** olarak (tek nokta
  değil). **Duvar-saati amortizedir**: her geçişte eğitim yükü holdout kazancından düşülür;
  CPU ve tepe RSS holdout-only'dir (eğitim CPU/RSS örneklenmez) ve öyle etiketlenir.
  Ölçülemeyen boyut `NOT_MEASURED`, asla türetilmez.
- **Restart:** yeni bir süreçte öğrenilmiş aday daha önce görülmemiş aynı-aile görevi yine
  yürütür (`applied_tested`); eligibility defteri yeni bir süreçte yeniden açılan journal'da
  korunur.
- **Dağılım kayması:** kaydırılmış kohort learned kolda uyum sağlar (`applied_tested`); uyum
  başarısızsa gizlenmez, raporlanır.
- **Eski-beceri:** öğrenmeden sonra yeniden koşulan set, kilitli non-inferiority sınırını
  karşılar; doğruluk eşit ve görev başına process sayısı baseline'ı aşmaz.
- **Bütünlük:** firewall bypass ve approval bypass ölçülür; yanlış yazma ölçülür; sıfırdan
  farklıysa `REJECT`.

## 7. Ön-kayıtlı eşikler (ölçümden önce kilitlendi)

- **Güç:** `n = max(minimumSamples, ceil(((z_alpha + z_power) * sigma / MIN_EFFECT)^2))`,
  `alpha 0.05` / `power 0.8` (`z_alpha 1.96`, `z_power 0.84`); `minimumSamples = 10`.
  `sigma` yoksa güç iddiası yapılmaz, `minimumSamples` yalnız **taban** olarak raporlanır.
- **MIN_EFFECT (metrik başına, donmuş):** `process 1.0`, `wallMs 100`, `cpuMs 100`,
  `rssBytes 8388608` (8 MiB).
- **Holdout boyutu:** aile başına 5, `N = 10` (`minimumSamples` tabanını karşılar).
- **Tekrar:** `R = 3` maliyet geçişi (geçiş 1 = ölçüm geçişi; geçiş 2–3 = tekrarlar).
- **Non-inferiority (eski-beceri):** her eski-beceri görevi için `learnedProcesses <=
  baselineProcesses` **ve** doğruluk eşit (`applied_tested`). Bu, "öğrenme eski beceriyi
  bozmadı" sınırıdır ve küçük n'de de kanıtlanabilir (#4380 ile aynı ölçü). Doğruluk
  Newcombe alt sınırı **ikincil** olarak raporlanır; bu n'de bir tabandır, kanıt değildir.
- **Kayma:** kaydırılmış kohortun **tamamı** learned kolda `applied_tested` olmalı.
- **Restart:** en az bir hiç görülmemiş görev restart sonrası `applied_tested`; eligibility
  defteri yeniden açılışta korunmalı.
- **Maliyet:** process kazancı paired her holdout görevinde pozitif; duvar-saati/CPU/RSS
  dağılım olarak raporlanır ve `INSUFFICIENT` olabilir (kazanç iddiası için şart değildir).
- **Yanlış yazma toleransı:** 0.

## 8. Karar kuralları (öncelik sırası) ve fail-closed

1. Mühürlü gerçek koşum yok veya holdout `N < minimumSamples` → `NOT_MEASURED` /
   `INSUFFICIENT`.
2. Eşleşmeyen kollar, bölme sızıntısı, geçersiz kayıt → `REJECT`.
3. Sıfırdan farklı firewall/approval bypass veya yanlış yazma → `REJECT`.
4. Aksi halde `MEASURED`; etiket kilitli kümeden:
   - ölçülen bir kapı karşılanmadı → `MEASURED_NO_GAIN`;
   - güç karşılanmadı veya holdout `N < minimumSamples` → `INSUFFICIENT`;
   - CPU veya RSS ölçülemedi → `NOT_MEASURED`;
   - tüm boyutlar ölçüldü ve tüm kapılar geçti → `GAIN`.

**`assertsGain` her durumda `false`** (§9): varsayılan/terfi ayrı PR ve G3 kabulü sonrasıdır.

## 9. İddia sınırı ve bağlama

- Bu protokol yalnız G3'ün **eksik** boyutlarını ölçer; bileşim (composition) boyutu bu işin
  kapsamı dışındadır ve G3 kapısı bu belgeyle tek başına **kapanmaz**.
- Kaynak gerçek ve mühürlüdür; **holdout/kalibrasyon/kayma/eski-beceri görevleri**
  `test/helpers/coder-g3-cohort-fixtures.js` fixture'larıdır. Ölçüm bu fixture'lar üzerinde
  gerçek CLI ve gerçek günlük deposu ile koşar.
- `assertsGain = false`; bu belge bir varsayılan/terfi veya genel öğrenme-başarısı iddiası
  kurmaz.
- Sonuç belgesi: `docs/task-packs/coder-learning-g3-closure-result-20261101.md`.
- Eval: `test/g3-closure-dimensions-result.test.js`.
