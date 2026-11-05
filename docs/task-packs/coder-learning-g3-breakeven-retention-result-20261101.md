# Coder öğrenme kazanımı — G3 break-even ufku ve önceki-beceri korunumu sonucu (result)

**Status:** `closeout`.
**Ön-kayıt:** `docs/task-packs/coder-learning-g3-breakeven-retention-preregistration-20261101.md`
(protokol ölçümden önce ayrı commit ile kilitlendi).
**Base:** `9d9d5d49` (origin/main). **Issue:** [#4505](https://github.com/ali-ulu/huqan/issues/4505).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060).
**Eval:** `test/g3-breakeven-retention.test.js`
(`node --test test/g3-breakeven-retention.test.js`).
**Önceki:** #4462 (N=70 mühürlü kohort, doğruluk/process `GAIN`); #4470 (kapanış boyutları,
eğitim dahil amortize maliyet `MEASURED_NO_GAIN`, eski-beceri `INSUFFICIENT`); #4465
(M3 H1 bağımsız aile korpusu `MEASURED_NO_GAIN`); #4428 (`NOT_MEASURED`).

## 1. Sonuç özeti

| Boyut | Sonuç | Verdict |
|---|---|---|
| Kaynak (§2) | Gerçek `coder --synthesize` mühürlü günlük kaydı; 60/60 retention + 2 eğitim koşumu `positive_procedure` | **MEASURED** |
| Önceki-beceri korunumu (§6) | Aile A becerisi, aile B öğrenmesinden **sonra** taze A görevlerinde dağıtıldı: **30/30** | **MEASURED** |
| Retention non-inferiority (§7) | pooled **60/60** vs baseline **60/60**, process kötüleşmedi, Newcombe alt sınırı **−0.0487 ≥ −0.05** | **MEASURED** (marj kanıtlandı) |
| Marj kanıtlanabilirliği (§7) | `N=60 ≥ 59` → `marginProvable=true` | **MEASURED** |
| Break-even — duvar-saati (§6) | eğitim medyanı **1737 ms** / görev-başı tasarruf medyanı **115.6 ms** → **n\*=16** (≤32) | **reached** |
| Break-even — CPU (§6) | eğitim medyanı **1660 ms** / görev-başı tasarruf medyanı **40.5 ms** → **n\*=41** (>32) | `NOT_REACHED` |
| Break-even — tepe-RSS (§6) | eğitim medyanı **582584 KB** / tasarruf medyanı **121858 KB** → **n\*=5** | rapor (kazanç kapısı değil) |
| Amortize net kazanç (§7, N=60) | duvar-saati **+5198 ms**, CPU **+772 ms** | pozitif ama kapı bağlayıcı değil |
| Yanlış yazma / approval bypass | **0 / 0** (gerçek probe ile ölçüldü) | eşik tetiklenmedi |
| Nihai etiket (§8) | — | **`MEASURED_NO_GAIN`** |
| `assertsGain` | — | **`false`** |

**Sonuç:** #4505'in istediği iki boşluk gerçek mühürlü kaynakta **ölçüldü**. Öğrenme mekanizması
önceki-beceri korunumunda **başarılıdır** (aile A becerisi, farklı-aile aile B öğrenmesinden
sonra da taze A görevlerinde dağıtılıyor; doğruluk non-inferior, marj kanıtlandı). Break-even
ufku ise **metrik-bağımlıdır**: duvar-saati **16** tekrarda geri ödenir, ama **CPU 41** tekrar
ister ve ön-kayıtlı `breakEvenHorizonMax=32` sınırını aşar. Bağlayıcı maliyet kapısı (duvar-saati
**ve** CPU birlikte ulaşmalı) bu yüzden geçmez → nihai etiket `MEASURED_NO_GAIN`.

## 2. Kaynak — mühürlü gerçek koşumlar (§2)

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>
  → experience_journal: hash-zincirli satırlar
  → readSealedRun(journal, '<id>:c1', 'default')
     = { ok:true, manifest.closed:true,
         learningEligibility:'positive_procedure', outcomeStatus:'verified' }
```

İki eğitim koşumu (`be-arith-train`, `be-string-train`) ve 60 retention koşumu (`be-a1..30`,
`be-s1..30`) mühürlü kayıt üretir; rapor her birini `sourceRevision.sealedRuns` altında
`sourceHash` + `manifest.closed` ile bağlar (test bunu 64-hex hash ve `closed:true` ile
doğrular). Bilinmeyen koşum `run_not_found` ile fail-closed reddedilir (§2 testi).

## 3. Ölçülen sayılar (temsili koşum, `t.diagnostic`)

```
retentionSize = 60   families = [arithmetic-expression, string-expression]
retention.pooled    = 60/60 learned, 60/60 baseline, processNotWorse true, newcombeLower -0.0487
retention.perFamily = arith 30/30, string 30/30 (her biri newcombeLower -0.0950)
marginProvable = true   (N=60 >= 59)
priorSkillRetained = true   (aile A becerisi aile B sonrasında da dağıtılıyor)
training.wallMs = [1819.3, 1711.5, 1737.4]   median 1737.4
training.cpuMs  = [1672.2, 1641.8, 1660.0]   median 1660.0
training.rssKb  = [582304, 583880, 582584]   median 582584
breakEven.wallMs = { trainingMedian 1737.4, savingMedian 115.6, horizonTasks 16, reached true }
breakEven.cpuMs  = { trainingMedian 1660.0, savingMedian  40.5, horizonTasks 41, reached false }
breakEven.rssKb  = { trainingMedian 582584, savingMedian 121858, horizonTasks 5, reached true }
savingInterval.wallMs = [101.4, 119.2] (mean 110.4)   cpuMs = [27.7, 44.6]   rssKb = [114962, 126728]
amortizedNet = { wallMs +5198, cpuMs +772 }
wrongWrites = 0   approvalBypass = 0   probeRefused = true   costMeasured = true
label = MEASURED_NO_GAIN   assertsGain = false
```

## 4. Neden `MEASURED_NO_GAIN` — ve neden bu #4470'ten farklı bir sonuç

- **Retention artık ölçüldü ve geçti.** #4470'in eski-beceri boyutu, öğrenilen belleğin aile
  başına tek aday tutması yüzünden "daha önce öğrenilmiş farklı bir becerinin korunması"nı
  temsil edemiyordu (`INSUFFICIENT`, `scope: fresh-same-family-transfer`). Bu ölçüm **iki
  farklı aile** becerisini sırayla öğrenip **her ikisinin de** taze görevlerini dağıttı: aile A
  becerisi (önce öğrenilen), aile B öğrenmesinden sonra da korunuyor. Bu, #4505'in
  "retention of a previously learned different skill" boyutunu gerçekten karşılar.
- **Break-even ufku metrik-bağımlı ve bağlayıcı olan CPU'da aşılıyor.** Per-görev tasarruf
  duvar-saati için ~116 ms (n\*=16) ama CPU için ~41 ms (n\*=41). İki farklı becerinin eğitim
  maliyeti (medyan ~1.74 s duvar / ~1.66 s CPU) CPU tarafında 32'lik ufuk sınırından önce geri
  ödenmiyor. Bu, #4470'in "sabit CLI başına maliyet baskın" bulgusuyla **aynı yöndedir** ama
  artık **ufuk** cinsinden ifade edilmiştir: öğrenme kazancı gerçektir (60/60 process + tasarruf
  pozitif), yalnız CPU maliyeti yeterince hızlı amortize olmaz.
- **Process kazancı deterministik.** Her retention görevi learned kolda da `applied_tested`;
  process sayısı baseline'dan kötü değil. Kazanç yokluğu bir regresyon değil, ölçülmüş bir
  maliyet-ufku sınırıdır.

## 5. İddia sınırı

- `assertsGain = false`; bu belge bir varsayılan/terfi iddiası kurmaz (§9). Varsayılan terfi
  ayrı PR ve G3 kabulü sonrasıdır.
- Ölçüm geçerlidir (`status: MEASURED`); etiket `MEASURED_NO_GAIN`'dir. `GAIN` bu kohortta
  çıkmadı; çıksaydı da **bu iki aile ve bu görev kümesi** için olurdu, genel öğrenme başarısı
  iddiası çıkarılmaz.
- **Kapsam:** N=70 doğruluk/process kanıtı #4462'de, güç/CPU/RSS/restart/kayma #4470'te ve
  M3 H1 #4465'tedir; burada **tekrarlanmadı**. Bu ölçüm yalnız break-even ufku ve önceki-beceri
  korunumu boyutlarını ekler.
- **Kaynak** gerçek ve mühürlüdür; **retention görevleri** `test/helpers/coder-g3-cohort-fixtures.js`
  fixture'larıdır. Ölçüm bu fixture'lar üzerinde gerçek CLI ve gerçek günlük deposu ile koşar.
- **Gerçek-repo sınırı (dürüst).** Öğrenme mekanizması yalnız bağımsız `test` + `synthesis`
  kontratlı görevlerde çalışır; `--synthesize` kontratsız bir görevde
  `Synthesis requires independent test.command` ile fail-closed düşer (#4428). Repoda
  **gerçek-repo synthesis görevi üreten bir yol yoktur**, bu yüzden #4505'in "Holdout tasks are
  non-fixture real repository tasks" kabul kriteri **bu mekanizmayla karşılanamaz**. Gerçek-repo
  görevleri ancak **farklı** bir mekanizmayla (`coder create`/`revise` proje yolu, gerçek Node
  API projeleri + gerçek HTTP kabul) mümkündür; o ayrı bir ölçüm olur ve bu belgede **kurulmaz**.
- **Ufuk sınırı:** `breakEvenHorizonMax = 32` ön-kayıtta donduruldu (aday havuzu üst sınırı).
  CPU n\*=41 bu sınırı aşar; sınır değiştirilirse sonuç değişir, ama sınır sonuç görülmeden
  kilitlendi.
- Bu ölçüm bir CI testidir (~127 gerçek alt süreç, yerel ~104 s); bu yüzden
  `scripts/heavy-test-files.js` içinde ağır dosya olarak kayıtlıdır.
