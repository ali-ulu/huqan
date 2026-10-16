# R51 — Anlam modeli holdout ölçüm sonucu (D kolu)

**Status:** PR5 sonucu. Karar: **STAY_SHADOW**. `DEFAULT_MODE` `shadow` olarak kalır (`lib/semantic-model-port.js`). Protokol ve eşikler `docs/task-packs/semantic-model-preregistration-r51.md` içinde donmuştur ve burada **değiştirilmedi**.
**Base:** issue [#3583](https://github.com/ali-ulu/huqan/issues/3583), roadmap anahtarı R51. Ölçülen kaynak commit: `f58b0716e05eb44cbc64faa8cbbec6037d7e524d`.
**Kapsam:** yalnız ölçüm ve karar. Üretim davranışı değişmedi; model çıktısı hâlâ `CANDIDATE_ONLY`; hiçbir claim otomatik reject/block/promote edilmedi.

## 1. Ne ölçüldü

Aynı donmuş R50 corpus'u (`test/fixtures/contradiction-eval-v1.*`, 108 pair; holdout 15, bunun 13'ü skorlanabilir: 5 `CONTRADICTION` / 8 `NOT_CONTRADICTION`), aynı eşik (0.5) ve aynı kalibratör sözleşmesi (`minimumSamples 10`, `smoothingAlpha 0.5`, R50 ile aynı) üzerinde dört kol:

| Kol | Ne | probabilityKind |
|---|---|---|
| A | R50 declared heuristic (`0.90/0.95`) | `DECLARED_HEURISTIC` |
| B | R50 kalibre rule-score (calibration split'te fit) | `CALIBRATED` |
| C | R50 yerel füzyon (train+calibration'da fit) | `CALIBRATED` |
| D | Paketli SSM modeli, port `shadow` modu, paketli kalibratör; `band: ABSTAIN` olan pair'lerde abstain | `CALIBRATED` (ama bu holdout'ta hiç ölçülemedi) |

Aile seçimi holdout'ta yapılmadı. Varsayılan aile SSM, ön-kayıtta önceden bildirilmiş. RWKV, MAMBA ve TRANSFORMER yalnız ikincil satır olarak, **karar için kullanılmadan** raporlandı (§5).

R50 sonuçlarının yeniden üretimi: B Brier `0.2414`, C Brier `0.2048`, B ECE `0.0385`, C ECE `0.0897`. Bunlar `contradiction-sensor-result-r50.md` ile eşleşir.

## 2. Holdout metrikleri (eşik 0.5)

| Metrik | A (declared) | B (calibrated rules) | C (local fusion) | D (SSM, port) |
|---|---|---|---|---|
| support (karar verilen) | 13 | 13 | 13 | **0** |
| TP / FP / TN / FN | 2 / 4 / 4 / 3 | 0 / 0 / 8 / 5 | 1 / 0 / 8 / 4 | — |
| precision | 0.333 | n/a (0 predicted) | 1.000 | n/a |
| recall | 0.400 | 0.000 | 0.200 | n/a |
| false-positive rate | 0.500 | 0.000 | 0.000 | n/a |
| coverage (A-C: predicted-positive / karar; D: non-abstain / skorlanabilir) | 0.462 | 0.000 | 0.077 | **0.000** |
| Brier | raporlanmaz | 0.2414 | 0.2048 | n/a |
| ECE | raporlanmaz | 0.0385 | 0.0897 | n/a |

Arm D'nin 13 holdout pair'inin tamamı abstain etti. Gerekçe: `calibration_insufficient` (13/13). Paketli SSM kalibrasyonu (`lib/semantic-model-artifacts/ssm.calibration.json`) `status: insufficient`, `reason: sample_below_minimum`, n=22; model kalibrasyonu 50 kayıt istiyor. Port bu durumda her pair için `band: ABSTAIN` döndürür, dolayısıyla D hiçbir pair'de olasılık üretmez. Bu bir model başarısızlığı değil, veri yetersizliğidir.

## 3. Eşlenmiş karşılaştırmalar (seeded paired-bootstrap, R50 sözleşmesi)

Sözleşme: `seed 3582`, `resamples 2000`, `confidenceLevel 0.95`, `meaningfulEffect 0.02`, `nonInferiorityMargin 0.02`, `minimumSamples 10`. Eşleme yalnız iki kolun da karar verdiği pair'lerde yapılır (D için bu küme boş).

```text
primary    D vs B   paired n = 0   -> INSUFFICIENT (sample_below_minimum)
secondary  D vs C   paired n = 0   -> INSUFFICIENT (sample_below_minimum)
```

R50'nin birincil karşılaştırması C vs B yeniden çalıştırıldı: `NO_MEANINGFUL_IMPROVEMENT` (R50 ile aynı sonuç).

## 4. Kuralların sinyal vermediği altküme

Altküme: holdout'ta hiçbir contradiction kuralının ateşlemediği skorlanabilir pair'ler. Sayı: **7** (3 `CONTRADICTION` / 4 `NOT_CONTRADICTION`). Bu altküme yalnız raporlanır, karar için kullanılmaz.

| Kol | support | Brier | ECE | not |
|---|---|---|---|---|
| B | 7 | 0.2564 | 0.1071 | 0 tahmin pozitif, FN 3 |
| C | 7 | 0.2564 | 0.1071 | B ile aynı metrikler |
| D | 0 | n/a | n/a | tamamı abstain |

Eşlenmiş D vs B ve C vs B bu altkümede `INSUFFICIENT`. Sonuç: kurallar sessiz olduğunda model değerlendirmesi de bu veriyle yapılamıyor.

## 5. İkincil aileler (karar için kullanılmadı)

| Aile | Non-abstain coverage | Abstain nedeni |
|---|---|---|
| RWKV | 0.000 | `calibration_insufficient` ×13 |
| MAMBA | 0.000 | `calibration_insufficient` ×13 |
| TRANSFORMER | 0.000 | `calibration_insufficient` ×13 |

Üç ailenin kalibrasyonu da aynı nedenle yetersiz. Bu satırlar **NOT_USED_FOR_DECISION** etiketlidir.

## 6. Donmuş eşiklerle karar

| Eşik (ön-kayıt) | Ölçülen | Durum |
|---|---|---|
| Holdout destek tabanı (`>= 10` skorlanabilir) | 13 | geçti |
| Non-abstain coverage `>= 0.10` | 0.000 | **başarısız** |
| Paired Brier CI alt sınırı `> 0` | ölçülemedi (0 pair) | **başarısız** |
| Paired Brier nokta iyileşmesi `>= 0.01` | ölçülemedi | **başarısız** |
| ECE bozulması `<= 0.02` | ölçülemedi | **başarısız** |
| FPR artışı `<= 0.02` | ölçülemedi | **başarısız** |
| Holdout adjudication `ADJUDICATED` | `PENDING_INDEPENDENT_HOLDOUT_REVIEW` | **başarısız** |

**Karar:** `STAY_SHADOW`. Gerekçeler: `non_abstain_coverage_below_0.10`, `paired_brier_not_measured`, `ece_not_measured`, `fpr_not_measured`, `holdout_adjudication_not_adjudicated`.

Adjudication kapısı ayrıca bağımsızdır. Eşikler geçse bile R50 ön-kaydının §3 ve §12–14 kuralı gereği promotion yeşil sayılmazdı.

## 7. Dürüst sonuç

- D kolu bu ölçümde **hiç karar üretmedi**. Sonuç "model kötü" değil, "model ölçülemedi" anlamına gelir. Kalibrasyon desteği (n=22) 50 kayıt eşiğinin altında.
- R50 holdout'unda 13 skorlanabilir pair, Brier/ECE farklarını tek başına bir eşiğe karşı güvenilir kılacak büyüklükte değil. R50 sonucu da bunu zaten belirtiyordu.
- Hiçbir kol için kazanım iddiası yoktur. `assertsGain` false kalır.
- Bu sonuç, R50'de C'nin reddedilmesiyle tutarlıdır: ölçüm, şimdiki veriyle ayrıt edici bir farkı kanıtlayamıyor.

## 8. Sonraki adım

1. **Daha fazla ve Türkçe veri.** Holdout'un bağımsız adjudication'ı tamamlanmadan promotion düşünülmez. Holdout dışı, Türkçe ve sınıf dengeli bir corpus gerekiyor.
2. **Yeni öğretmen ve dataset turu.** Mevcut 100 kayıtlık SNLI tabanlı örneklem (76 train / 24 calibration) hem kalibrasyon hem eğitim için küçük. Yeni öğretmen çıktıları ayrı provenance ile eklenmeli.
3. **Kalibrasyonun yeniden fit edilmesi.** Yeni calibration split'te ≥ 50 kayıt olunca paketli `*.calibration.json` yeniden üretilmeli (`scripts/calibrate-semantic-model.js`). Bu, holdout'a dokunmadan yapılmalı.
4. **Ölçümün tekrarı.** Aynı script (`scripts/semantic-model-holdout-eval.js --source-commit=<sha>`) yeni commit ve yeni artifact ile yeniden çalıştırılır. Eşikler değiştirilmez.

Bu aşamada `DEFAULT_MODE` `shadow` kalır. Model çıktısı yalnız `CANDIDATE_ONLY` sinyal olarak raporlanır; hiçbir rule sinyalini ezmez.

## 9. Doğrulama

```bash
node scripts/semantic-model-holdout-eval.js --source-commit=f58b0716e05eb44cbc64faa8cbbec6037d7e524d
node --test test/semantic-model-holdout-eval.test.js
```

- Script iki çalıştırmada byte-identical çıktı üretir (test kapsamında).
- Holdout etiketleri değiştirildiğinde B ve C olasılıkları değişmez (fit yalnız calibration ve train split'lerini görür).
- Karar fonksiyonu sentetik sayılarla test edilir: geçiş, her eşiğin başarısızlığı, sınır değerleri ve yetersiz destek.
