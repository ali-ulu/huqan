# R50 — Contradiction sensor ölçüm sonucu

**Status:** PR4 sonucu yayımlandı. Bu dosya ölçümün **bulgularını** taşır; protokol, eşikler ve ön-kayıt `docs/task-packs/contradiction-sensor-preregistration-r50.md` içinde dondu ve burada **değiştirilmedi**.
**Base:** issue [#3582](https://github.com/ali-ulu/huqan/issues/3582), roadmap anahtarı R50. İlgili hat: [#3583](https://github.com/ali-ulu/huqan/issues/3583) (R51, D kolu).
**Kapsam:** yalnız ölçüm. Hiçbir üretim yolu değişmedi; candidate authority genişlemedi; hiçbir claim canonical memory'ye yazılmadı.

## 1. Ne ölçüldü

Aynı donmuş corpus (108 pair; `train 73 / calibration 20 / holdout 15`), aynı skorlanabilir holdout (13 pair: 5 `CONTRADICTION` / 8 `NOT_CONTRADICTION`) üzerinde üç kol:

| Kol | Ne | probabilityKind |
|---|---|---|
| A | Bugünkü detector coverage + beyan edilmiş `0.90/0.95` heuristic confidence | `DECLARED_HEURISTIC` |
| B | Aynı raw rule score, calibration split'te fit edilmiş donmuş score→P eşlemesi | `CALIBRATED` |
| C | Donmuş deterministic feature vektörü + HUQAN'a ait yerel `ridgeFit` füzyonu + **kendi skor dağılımı üzerinde fit edilmiş** kalibrasyon | `CALIBRATED` |

Birincil karşılaştırma **C vs B**'dir (eşlenmiş, seeded paired-bootstrap). A'yı geçmek tek başına yeterli değildir.

## 2. Holdout sonucu (eşik 0.5)

| Metrik | A (declared) | B (calibrated rules) | C (local fusion) |
|---|---|---|---|
| predicted positive | 6 | 0 | 1 |
| TP / FP / TN / FN | 2 / 4 / 4 / 3 | 0 / 0 / 8 / 5 | 1 / 0 / 8 / 4 |
| precision | 0.333 | n/a (0 predicted) | 1.000 |
| recall | 0.400 | 0.000 | 0.200 |
| false-positive rate | 0.500 | 0.000 | 0.000 |
| coverage | 0.462 | 0.000 | 0.077 |
| Brier | raporlanmaz | 0.2414 | 0.2048 |
| ECE | raporlanmaz | 0.0385 | 0.0897 |

A'nın Brier/ECE'si yoktur: beyan edilmiş heuristic confidence kalibre edilmiş bir outcome probability değildir, bu yüzden ölçüme sokulmaz. A'nın değeri yüksek FPR'dır (0.5): sabit `0.90/0.95` güveni holdout'un yarısında yanlış pozitif üretiyor. C ise eşik 0.5'te yalnız 1 pozitif der ve o pozitif gerçektir (precision 1.000).

## 3. Eşlenmiş C vs B karşılaştırması

```text
direction       lower-brier-is-better
paired n        13
Brier delta     mean +0.03659   %95 CI [-0.03806, +0.11124]
ECE delta       +0.05128       non-inferiority margin 0.02  -> NOT non-inferior
```

**Final durum:** `NO_MEANINGFUL_IMPROVEMENT` → `FUSION_REJECTED_BY_MEASUREMENT`.

Gerekçe: C'nin Brier'ı B'den iyidir (mean +0.03659) ama güven aralığının **alt sınırı** donmuş anlamlılık eşiğini (`meaningfulEffect = 0.02`) geçmez (negatiftir). Eşiği nokta tahmini değil aralık geçmelidir; bu yüzden kazanç iddia edilmez. ECE non-inferior değildir (delta 0.05128 > margin 0.02). C'nin kaybetmesi R50 için geçerli bir sonuçtur; issue yine başarıyla kapanır.

Not: C'nin kalibrasyonu kendi skor dağılımı üzerinde fit edilmeseydi C hiç pozitif demez, Brier/ECE fit edilen eşleme tarafından desteklenmezdi; yukarıdaki sayılar ayrı artifact'ın sonucudur.

## 4. Destek-kapılı zayıflık profili

Zayıflık profili ölçümden **sonra** üretilir. `support < 5` olan detector `INSUFFICIENT_FOR_DETECTOR_CLAIM` döner; sayı yazılmaz.

| Kural | holdout support | claim |
|---|---|---|
| `NUMERICAL_CONFLICT` | 5 | MEASURED |
| `NEGATION_CONFLICT` | 1 | INSUFFICIENT_FOR_DETECTOR_CLAIM |
| `VALUE_CONFLICT`, `TYPE_CONFLICT`, `UNIT_CONFLICT`, `CAUSE_PREVENT_OPPOSITION`, `SEMANTIC_OPPOSITION`, `RELATION_INVERSION`, `PREDICATE_DRIFT` | 0 | INSUFFICIENT_FOR_DETECTOR_CLAIM |

Holdout yalnız 13 skorlanabilir pair taşıdığı için tek bir detector dışında hiçbir kural hakkında iddia kurulamaz. Bu bir eksiklik değil, ön-kaydın istediği dürüstlüktür: az destekte sayı üretmek gürültüyü bulgu gibi sunardı.

## 5. Simülasyon-only abstention politikası (C kolu olasılığı)

Eşikler: `low = 0.35`, `high = 0.65`. Simülasyon, C'nin kalibre olasılığıyla holdout üzerinde:

```text
NO_DETECTED_CONTRADICTION     14
ABSTAIN                        0
CONTRADICTION_REVIEW_CANDIDATE 1
```

`NO_DETECTED_CONTRADICTION` iki claim'in **uyumlu/doğru** olduğu anlamına gelmez; yalnız kalibre olasılığın düşük kaldığını söyler. Politika üretime **bağlanmadı** (`productionWiring: false`); auto-block/reject/promotion yoktur. Guard'lardan biri eksik/uyumsuzsa (kalibrasyon artifact'ı yok, digest uyuşmuyor, bilinmeyen feature spec, detector-source digest uyuşmuyor, yetersiz kalibrasyon desteği, non-finite skor) tüm kararlar `ABSTAIN` olur.

## 6. No-external-dependency

`test/cognitive-lab-contradiction-no-external-dependency.test.js` mekanik olarak kanıtlar:

- contradiction lab entry point'lerinden require grafiği `llmAdapter.js`'e ulaşmaz (`scripts/check-deterministic-path.js` export edilen checker ile);
- hiçbir entry point model/embedding paketi ya da network primitifi require etmez;
- füzyon yetkisi `DETERMINISTIC / LOCAL / CANDIDATE_ONLY / canonical:false`, `modelCalls = 0`, `tokens = 0`, `externalCalls = 0`.

## 7. Definition of done karşılığı

```text
frozen labeled corpus valid          -> evet (PR1)
minimum sample gates satisfied       -> evet (train 63 / calibration 16 / holdout 13 skorlanabilir; ADEQUATE)
A/B/C same frozen holdout            -> evet (aynı 13 karar)
calibration + discrimination metrics -> evet (§2)
paired uncertainty evidence          -> evet (§3, seeded paired-bootstrap CI)
fusion artifact reproducible         -> evet (PR3, digest-bağlı)
external runtime dependency = 0      -> evet (§6)
candidate authority preserved        -> evet (CANDIDATE_ONLY, canonical:false)
measured weakness profile published  -> evet (§4)
full CI green                        -> PR CI'da
production behavior unchanged        -> evet (productionBehaviorChanged:false)
```

C'nin B'yi geçmesi close şartı değildir; ölçüm füzyonu reddetti.

## 8. Doğrulama

```bash
node --test test/cognitive-lab-contradiction-report.test.js
node --test test/cognitive-lab-contradiction-policy.test.js
node --test test/cognitive-lab-contradiction-no-external-dependency.test.js
node scripts/build-contradiction-eval-fixture.js --check   # 0
```

## 9. Sınırlar ve devir

- **Örneklem sentetiktir.** Corpus, deduplikasyon sonrası 110 benzersiz pair'lik kaynak havuzundan stratum hedefleriyle seçilen 108 pair'den oluşur; mutlak precision/recall doğal dağılıma genellemez. Karşılaştırma geçerlidir, mutlak değerler değil.
- **Holdout bağımsız adjudication'ı** ön-kayıtta `PENDING_INDEPENDENT_HOLDOUT_REVIEW` olarak kayıtlıdır; promotion gate'i bu alan `ADJUDICATED` olmadan yeşil sayılmaz. Bu nedenle §2–§5 sayıları **geçicidir**: bağımsız inceleme tamamlanmadan promotion/tuning/eşik seçimi için kullanılamaz (ön-kayıt §3.1'de kayıtlı protokol sapması).
- **C reddedildi ama yasaklanmadı.** Ölçüm "bu holdout'ta B'nin üstüne ölçülebilir değer koymuyor" der; daha büyük/representative bir corpus'ta yeniden ölçülebilir.
- **Üretim entegrasyonu açılmadı.** `semantic-signals.js` davranışı değişmedi; hiçbir contradiction candidate otomatik bloklanmadı/reddedilmedi/terfi ettirilmedi.
- **D kolu (R51, #3583)** aynı donmuş holdout'a öğretmenlerden öğrenmiş bir anlam modelini ekleyecek; bu ölçüm onun baseline'ıdır.
