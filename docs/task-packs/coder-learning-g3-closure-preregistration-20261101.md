# Coder öğrenme kazanımı — G3 kapanış kapısı boyutları ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Külliyat (§4), bölme (§5), metrikler (§6),
eşikler (§7) ve karar kuralları (§8) bu commit ile donduruldu. Ölçüm bu commit'ten **sonra**,
aynı PR içinde koşulur; sonuç ayrı bir belgede raporlanır
(`coder-learning-g3-closure-result-20261101.md`).

**Base:** `70099e37` (origin/main).
**Issue:** [#4470](https://github.com/ali-ulu/huqan/issues/4470).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki:** #4449 → PR #4462 (genişletilmiş mühürlü kohort, N=70, `GAIN`); #4416 (güç + tekrarlı
maliyet, 10 görevlik sentetik dilim, `MEASURED_NO_GAIN`); #4380 (restart + eski beceri, 6 görevlik
dilim).

## 0. Amaç ve sınır

`docs/cognitive-architecture-plan.md` G3 kapanış kapısı şunu ister: *"G3 bileşim, maliyet,
değişen ortam, restart ve eski beceri ölçümleri kaynak SHA/manifest ile raporlandı"* ve
*"Maliyet: model/araç çağrısı, süre ve bellek ayrı raporlanır"*.

#4462 yalnız **doğruluk non-inferiority** ve **işlem maliyeti**ni genişletilmiş kohortta
ölçtü; sonuç belgesi §9 geri kalanını açıkça "ayrı ön-kayıt ve koşumlar" diye erteledi. Bu
belge o kalan boyutları **gerçek mühürlü kaynak üzerinde** ölçer: güç, tekrarlı CPU/tepe-RSS
dağılımı, eğitim dahil amortize maliyet, restart, dağılım kayması ve eski beceri
non-inferiority.

Sınırlar:
- Bu bir **ölçüm protokolüdür**. Runtime kodu, wiring, eşik veya varsayılan değişmez;
  `lib/` altında hiçbir dosya değişmez.
- **Kapsam kararı (en küçük tam değişiklik):** N=70 doğruluk/process non-inferiority kanıtı
  zaten #4462'de ölçüldü ve commit'e bağlandı; burada **tekrarlanmaz**. Bu ölçüm kendi
  kohort boyutunun non-inferiority sınırını dürüstçe raporlar ve N=70 kanıtını atıf yapar.
- Kaynak yine **gerçek** `coder --synthesize` mühürlü günlük kaydıdır (§2). Holdout
  **görevleri** fixture'dır (#4449 ile aynı sınırlama, §9); kaynak değildir.
- Sonuç ne çıkarsa `GAIN` / `MEASURED_NO_GAIN` / `INSUFFICIENT` / `NOT_MEASURED` / `REJECT`
  olarak olduğu gibi raporlanır. Yönlü bir sonuç vaat edilmez.

## 1. Hipotezler

- **H0:** Ölçülen boyutlarda learned kol ya (a) güç/örneklem tabanını karşılamaz, ya
  (b) eğitim dahil amortize maliyette (duvar-saati/CPU/RSS) kazanç göstermez, ya
  (c) restart/dağılım kayması/eski beceri kapılarından birini geçemez.
- **H1 (yönlü):** Learned kol; restart sonrası yeni bir same-family görevi dağıtır, kaymış
  bir kohortta uyum sağlar, eski beceride non-inferior kalır ve eğitim dahil amortize
  duvar-saati/CPU/RSS kazancı pozitif olur (process kazancı ayrı raporlanır).

## 2. Gerçek görev kaynağı (kanıtlanmış zincir — #4449 ile aynı)

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>   lib/cli-coder.js
  -> experience_journal: 7 hash-zincirli satır                            lib/experience/journal.js
  -> readSealedRun(journal, '<id>:c1', workspaceId)                       lib/experience/learning-intake.js
     => { ok:true, manifest.closed:true,
          learningEligibility:'positive_procedure', outcomeStatus:'verified' }
```

- Kaynak yalnız `manifest.closed === true` mühürlü koşumlardır; açık veya düzenlenmiş kayıt
  fail-closed reddedilir (`run_not_sealed` / `integrity_mismatch`). Replay edilmiş bir
  istek kimliği disk etkisini tekrarlayamaz (`coder-learned-acceptance-matrix`).
- Her holdout görevinin learned koşumu bu mühürlü kaydı üretir; ölçüm bunu **görev başına**
  doğrular (`sealedEligibility === 'positive_procedure'`).

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Aile başına taze çalışma kökü; görevler `--synthesize`, bellek yok. |
| Learned kol | Aynı görevler; aile eğitim görevi `--synthesize` + `rememberFile`, sonra `--adapt-memory`. |
| Eşit bütçe | Her iki kol `BUDGET = 8` process limiti; aynı görev hash'leri, aynı kaynak, aynı test komutları. |

## 4. Külliyat (ölçümden önce kilitlendi)

- **Birim:** mühürlü bir synthesis koşumundan türetilen bir görev.
- **Aileler (2, bağımsız):** `arithmetic-expression` (buggy `p => p + 1`, hedef `p % 2`) ve
  `string-expression` (buggy `p.toUpperCase()`, hedef `p.trim().toLowerCase()`).
- **Eğitim görevi:** aile başına 1 (kohortta sayılmaz).
- **Kalibrasyon dilimi:** aile başına **2** görev. Yalnız `sigma` üretir; holdout'a girmez,
  hiçbir holdout kararında kullanılmaz.
- **Holdout:** aile başına **5**, toplam **N = 10** (§7 gerekçe).
- **Dağılım kayması:** aile başına **1** görev, aynı aile ama uç değer aralığı (OOD).
- **Eski beceri (prior skill):** aile başına **2** daha önce öğrenilmiş same-family görev.
- **Anti-vaka:** `manifest.closed !== true` veya `learningEligibility` pozitif prosedür değil
  → görev kohorttan düşer (fail-closed).

## 5. Bölme ve sızıntı

- Bölmeler `train / calibration / holdout / shift / prior-skill` düzeyinde ayrılır; eğitim ve
  kalibrasyon görev kimlikleri holdout'ta **görünmez** (`assert` ile kontrol edilir,
  sızıntı → `REJECT`).
- Holdout hiçbir eğitim/kalibrasyon/selection adımında kullanılmaz.

## 6. Metrikler ve yön

- **Birincil:** bağımsız gözlenmiş görev başarısı / yanlış yazma oranı.
- **İkincil:** görev başına doğrulama process sayısı (paired, baseline − learned).
- **Maliyet:** duvar-saati, CPU ve **tepe RSS** ayrı raporlanır. Amortize toplam **eğitim
  maliyetini içerir**. R ≥ 3 tekrar; dağılım (medyan + işaret kararlılığı) raporlanır,
  tek nokta değil. Ölçülemeyen boyut `NOT_MEASURED` kalır.
- **Restart:** taze process restart sonrası learned aday yeni bir same-family görevi
  dağıtmalı; eligibility defteri yeni process'te yeniden açılışta korunmalı.
- **Dağılım kayması:** kaymış kohort uyumu ölçülür; uyum başarısızlığı gizlenmez.
- **Eski beceri non-inferiority:** öğrenme sonrası eski görev kümesi ön-kayıtlı sınırı geçmeli.
- **Bütünlük:** firewall bypass ve approval bypass ölçülür; sıfırdan farklıysa `REJECT`.

## 7. Ön-kayıtlı eşikler (ölçümden önce kilitlendi)

- **Güç:** `n = max(minimumSamples, ceil(((z_alpha + z_power) * sigma / MIN_EFFECT)^2))`,
  `alpha 0.05` / `power 0.8` (`z_alpha 1.96`, `z_power 0.84`), M9 holdout ön-kaydıyla aynı
  yöntem (`lib/cognitive-lab-m9-holdout.js::requiredSample`).
- **sigma:** **gerçek kalibrasyon diliminden** (aile başına 2 görev, paired deltalar) ölçülür,
  metrik başına. Process deterministik olduğu için `sigma≈0`; duvar-saati, CPU ve RSS koşum
  gürültüsü taşır.
- **MIN_EFFECT (dondurulmuş):** process `1.0`, wallMs `100`, cpuMs `100`, rssKb `2048`.
- **minimumSamples:** `10` (taban). `holdoutSize < requiredSample` → `INSUFFICIENT`.
- **Bağlayıcı güç kapısı birincil metrik (process):** `#4416` örneğinde olduğu gibi,
  sufficiency kapısı birincil (deterministik) metriğin gücüdür. Duvar-saati/CPU/RSS güç
  sonuçları metrik başına **raporlanır** ama bağlayıcı değildir; bu metriklerin **ölçülmüş**
  olması gerekir. Gerekçe: toplam tepe-RSS gibi gürültülü bir toplu metrik, CI'da
  karşılanabilir N'de makul bir asgari etkiyle güçlendirilemez; onu kapı yapmak ölçümü
  imkânsız kılar. Bu yüzden RSS dağılım olarak raporlanır, `rssKb.powerMet` dürüstçe
  bildirilir (bu kohortta `false`), ama etiketi tek başına belirlemez.
- **Maliyet:** eğitim dahil amortize duvar-saati **ve** CPU kazancı R ≥ 3 tekrarda **işaret
  kararlı** ve medyan **> 0** olmalıdır; aksi `MEASURED_NO_GAIN`. RSS dağılım olarak
  raporlanır (kazanç kapısı değil).
- **Restart:** learned restart görevi `applied_tested`, process < baseline; defter yeniden
  açılışta `positive_procedure` korunur.
- **Dağılım kayması:** kaymış görev `applied_tested` olmalı; uyum sağlanamazsa raporlanır
  (`MEASURED_NO_GAIN`), gizlenmez.
- **Eski beceri:** öğrenme sonrası eski görev kümesinde doğruluk non-inferiority tek-yönlü %95
  **tam (Newcombe)** alt sınırı `≥ -0.05` ve process sayısı baseline'dan kötü olmamalı.
- **Yanlış yazma toleransı:** 0.

## 8. Karar kuralları (öncelik sırası) ve fail-closed

1. Mühürlü gerçek koşum yok veya N < `minimumSamples` → `NOT_MEASURED` / `INSUFFICIENT`.
2. Eşleşmeyen kollar, bölme sızıntısı, geçersiz kayıt → `REJECT`.
3. Sıfırdan farklı firewall/approval bypass veya yanlış yazma → `REJECT`.
4. Aksi halde `MEASURED`; etiket kilitli aralıktan:
   - amortize maliyet medyanı > 0 **ve** işaret kararlı **ve** restart/dağılım kayması/eski
     beceri kapıları geçilmiş → **GAIN**;
   - maliyet medyanı ≤ 0 (kararlı) → **MEASURED_NO_GAIN**;
   - güç/örneklem yetersiz veya bir maliyet boyutu ölçülemedi → **INSUFFICIENT**.

**`assertsGain` her durumda `false`** (§9): varsayılan/terfi ayrı PR ve G3 kabulü sonrasıdır.

## 9. İddia sınırı ve bağlama

- Bu protokol G3 kapanış kapısının eksik boyutlarını gerçek mühürlü kaynakta ölçer;
  N=70 doğruluk non-inferiority kanıtı #4462'dedir ve burada tekrarlanmaz.
- Kaynak gerçek ve mühürlüdür; **holdout görevleri** `test/helpers/coder-g3-cohort-fixtures.js`
  fixture'larıdır. Ölçüm bu fixture'lar üzerinde gerçek CLI ve gerçek günlük deposu ile koşar.
- `assertsGain = false`; bu belge bir varsayılan/terfi iddiası kurmaz.
- Sonuç belgesi: `docs/task-packs/coder-learning-g3-closure-result-20261101.md`.
- Eval: `test/g3-closure-dimensions.test.js`.
