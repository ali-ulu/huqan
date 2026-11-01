# Coder öğrenme kazanımı — G3 genişletilmiş mühürlü kohort sonucu (result)

**Ön-kayıt:** `docs/task-packs/coder-learning-g3-sealed-cohort-preregistration-20261101.md`
(protokol ölçümden önce, ayrı commit ile kilitlendi).
**Base:** `411dcba6` (origin/main). **Issue:** [#4449](https://github.com/ali-ulu/huqan/issues/4449).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060).
**Eval:** `test/g3-sealed-run-cohort-result.test.js` (`node --test test/g3-sealed-run-cohort-result.test.js`).
**Önceki:** `docs/task-packs/g3-sealed-run-learning-result-20261030.md` (#4432, N=10,
`MEASURED_NO_GAIN`).

## 1. Sonuç özeti

| Boyut | Sonuç |
|---|---|
| Kaynak (§2) | Gerçek `coder --synthesize` mühürlü günlük kaydı — **kaynak kanıtlandı, öğrenme mekanizmasını taşıyor** |
| Kohort (§4) | 2 aile (`arithmetic-expression`, `string-expression`), **N = 70** holdout görevi (aile başına 35) |
| Marja yeterlilik (§7) | `marginProvable = true` (N = 70 ≥ 59); #4432'nin N=10'da **yapısal olarak** karşılayamadığı marj bu kez ölçülebilir |
| Doğruluk (§6) | learned **70/70** `applied_tested`; tam (Clopper–Pearson) alt sınır **0.9581** |
| Non-inferiority (§7) | Newcombe tam alt sınır **−0.0419** ≥ kilitli **−0.05** → **non-inferior** |
| İşlem maliyeti (§6) | paired kazanç **70/70** (Δ = 3×35, 2×35); paired bootstrap alt sınırı **+2.386 > 0** |
| Duvar-saati (§6) | baseline 56 538 ms vs learned 48 848 ms → **+7 690 ms** (ayrı rapor; kazanç kapısı değil) |
| Yanlış yazma | **0** — ölçüldü: her iki kolun `changedPaths`'i yalnız kendi kaynak dosyası |
| Bütünlük (§6) | **ölçüldü**: `--authorize` olmadan `arith-h1` yeniden koşuldu → `needs_human_decision`, boş changed-set; firewall bypass **0**, approval bypass **0** |
| Güç (§7) | `power: NOT_DERIVED` (calibration bölmesi yok → `sigma` hesaplanamaz) |
| Nihai etiket (§8) | **`GAIN`** |
| `assertsGain` | **`false`** |

**H1 verdict: `GAIN`.** Ölçüm geçerlidir, kaynak gerçek ve mühürlüdür, kohort kilitli marjı
kanıtlayacak kadar büyüktür, ve kilitli karar kuralının **her iki** koşulu birlikte sağlanır:
işlem kazancının alt sınırı > 0 **ve** doğruluk non-inferior. Bu, #4432'nin `MEASURED_NO_GAIN`
sonucunu **çürütmez**; onu tamamlar: #4432'de etiket kohortun marjı kanıtlayamamasından
geliyordu, kazanç yokluğundan değil (§4).

## 2. Kaynak — mühürlü gerçek synthesis koşumu (§2, #4432 ile aynı)

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>
  → experience_journal: 7 hash-zincirli satır
  → readSealedRun(journal, '<id>:c1', 'default')
     = { ok:true, events:7, manifest.closed:true,
         learningEligibility:'positive_procedure', outcomeStatus:'verified' }
```

Her holdout görevinin learned koşumu bu mühürlü kaydı üretir ve ölçüm bunu **görev başına**
doğrular (`sealedEligibility === 'positive_procedure'`, 70/70). Eğitim koşumları bilerek
nitelik redlerini (drift/ambiguous) çalıştırdığı için kendi kayıtları `negative_example`
kapanır; **holdout** koşumları aday kohorttur.

## 3. Ölçülen sayılar

```
trials = 70        families = [arithmetic-expression, string-expression]
learned outcome    = 70/70 applied_tested        baseline = 70/70 applied_tested
accuracy lower     = 0.9581 (exact, one-sided 95%)
non-inferiority    = -0.0419 (Newcombe exact, learned - baseline)   margin = -0.05
process deltas     = [3 x35, 2 x35]              per-task gain = 70/70
process lower      = +2.386 (paired bootstrap, 2.5%)
wall time          = baseline 56538ms vs learned 48848ms -> +7690ms
wrong writes = 0   firewall bypass = 0   approval bypass = 0
power              = NOT_DERIVED (calibration bölmesi yok → §7 sigma hesaplanamaz)
```

## 4. Neden #4432 `MEASURED_NO_GAIN`, bu ölçüm `GAIN` — fark kohort boyutu

#4432 ile aynı kaynak, aynı iki aile, aynı bütçe, aynı karar kuralı. Tek fark **N**:

| N | Newcombe alt (0 fark) | marj ≥ −0.05 | §8 etiketi |
|---|---|---|---|
| 10 (#4432) | −0.2589 | hayır | `MEASURED_NO_GAIN` |
| 40 | −0.0722 | hayır | `MEASURED_NO_GAIN` |
| 58 | −0.0503 | hayır | `MEASURED_NO_GAIN` |
| **70 (bu ölçüm)** | **−0.0419** | **evet** | **`GAIN`** |

#4432 §4 zaten bunu öngörmüştü: "Aynı ölçüm `n ≥ 59` holdout ile tekrarlanırsa marj
karşılanabilir (yeni ön-kayıt gerektirir)". Bu belge o yeni ön-kaydın sonucudur. Yani
`MEASURED_NO_GAIN`, öğrenmenin yokluğu değil, **kohortun marjı kanıtlayacak kadar büyük
olmamasının** ölçülmüş halidir (#4422 sıfır-varyans dersi).

## 5. İşlem ve duvar-saati kazancı

learned kol her görevde **2–3 işlem** daha az kullandı (70/70); bootstrap alt sınırı
**+2.386 > 0**. Duvar-saati de bu kez learned lehine **+7 690 ms** (N=70 toplamı); #4380/#4416
dersi gereği bu **ayrı** raporlanır ve §8 `GAIN` etiketi için kapı değildir — etiket yalnız
işlem alt sınırı ve doğruluk non-inferiority'ye bakar. Eğitim maliyeti (2 koşum) bu toplama
dahil değildir; §6 onu ayrı bir satır olarak ister, bir kapı olarak değil.

## 6. İddia sınırı

- `assertsGain = false`; bu belge bir varsayılan/terfi iddiası kurmaz (§9). Varsayılan
  terfi ayrı PR ve G3 kabulü sonrasıdır.
- Ölçüm geçerlidir (`status: MEASURED`); etiket `GAIN`'dir. Ancak `GAIN` **bu iki aile ve bu
  görev kümesi** için ölçülmüştür; genel öğrenme başarısı iddiası çıkarılmaz (§4, 2 bağımsız
  aile).
- Kaynak gerçek ve mühürlüdür: mühürlü kayıtlar gerçek `coder --synthesize` koşumlarından
  gelir, sentetik değildir. **Holdout görevleri** ise `test/helpers/coder-g3-cohort-fixtures.js`
  içindeki `installArith` / `installString` ile üretilen fixture'lardır; ölçüm bu fixture'lar
  üzerinde gerçek CLI ve gerçek günlük deposu ile koşar.
- §7 güç iddiası kurulmaz: protokol `sigma`'yı calibration bölmesinden ister; bu kohortta
  calibration bölmesi yok, bu yüzden `minimumSamples` yalnız bir **taban** olarak raporlanır
  (`power: NOT_DERIVED`), bir güç sonucu olarak değil.
- Bu ölçüm bir CI testidir ve N=70 (142 gerçek alt süreç) ile koşar; bu yüzden
  `scripts/heavy-test-files.js` içinde ağır dosya olarak kayıtlıdır (yerel ~112 s).
