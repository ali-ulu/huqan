# V0.1 — Cognitive Lab giriş görev paketi

**Status:** proposed implementation task; ölçüm altyapısı planıdır. Gain veya production wiring PASS değildir.
**Base:** `83000331c07e4c9bb592dfc75b12851d3aa3ee8a`, package `0.12.0`.
**Owner:** tek uygulayıcı; bağımsız denetçi raporu okumadan önce negatif kabul deneyi koşar.

2 Ekim güncellemesi: bu görevde [mühendislik teslim sözleşmesi](engineering-foundation-20261002.md)
ve `docs/agent-canon.md::ENGINEERING-001` uygulanır. Source base tarihi snapshot'tır;
işe başlarken güncel main kullanılır. Dream import bug #3313 ile upstream düzeltilmiştir.
Yeni test işi mevcut impact/JUnit akışını kullanır; ayrı ağır PR framework kurulmaz.

## Problem ve ilk görünür sonuç

HUQAN'da inference/belief revision, Dream, sealed experience proposal, fitness ve reliability primitive'leri var. Yeni mekanizmaların gerçekten daha iyi reasoning/learning verdiğini eşit bütçede, görülmemiş görevlerde ve authority sınırını koruyarak belirleyen ortak Cognitive Lab sözleşmesi denetlenmiş değildir.

İlk sonuç bir yeni engine değil, mevcut B1 belief revision baseline'ının tekrar üretilebilir ölçümü ve evaluator sağlamlığıdır. Kullanıcı bir run'da baseline kimliğini, split/budget bütünlüğünü, observed/censored sayımlarını, B1 sonucunu ve B2–B8'in ölçülmediğini görebilmelidir.

## Reuse ve ön inceleme

- `lib/inference-runtime.js`, `lib/inference-runtime-beliefs.js`, `lib/inference-belief-revision*.js`: existing public workflow ve posterior/revision; private Core→Application bağımlılığı ekleme.
- `lib/trust-calibration.js`, `lib/trust-signals/robustness.js`, `lib/hypothesis-fitness.js`, `lib/fitness-history.js`: önce mevcut result/status/report biçimlerini incele; ikinci kalibrasyon veya history authority kurma.
- `lib/experience/learning-intake.js`: sealed source hash/proposal kaydını yeniden kullan; candidate `registered:false` sözleşmesini aşma.
- Existing graph/receipt/admission: experiment çıktısı evidence olabilir; canonical knowledge veya policy yetkisi olarak otomatik kabul edilmez.

Uygulama başlamadan bu listede caller ve test keşfi yenilenir. Kamuya açık port varsa onun üzerinden çağır; immutable fixture ve sonuçlar için standart kütüphaneyi kullan. CLI/MCP/HTTP'ye yeni kullanıcı yüzeyi bu ilk dilimin amacı değildir.

## Önerilen dar dosya sahipliği

Yeni dosya adları tasarım önerisidir; mevcut uygun yüzey bulunursa onu kullan:

| Dosya | Sorumluluk |
|---|---|
| `schemas/cognitive-lab-run.schema.json` | Strict run manifest/result contract; unknown alanlar ve invalid flags reject |
| `scripts/cognitive-lab/run.js` | Opt-in offline baseline koşumu; read-only source/fixture; isolated temp state |
| `scripts/cognitive-lab/evaluate.js` | Saf denominator/split/budget/integrity değerlendirmesi |
| `test/cognitive-lab-contract.test.js` | Şema ve evaluator negatif/pozitif karakterizasyonları |
| `test/cognitive-lab-baseline.test.js` | Gerçek existing inference/belief workflow, replay ve ablation plumbing |
| `test/fixtures/cognitive-lab/b1/` | Bağımsız support, counter, duplicate-source, censored, stale support aileleri |

Yalnız gerekliyse bir npm komutu ekle; runtime publication/port ownership değişikliği yapma. Test fixture'in bilgi kaynağı veya hash'i kaybolmamalı. Shipped runtime'a konulacaksa ayrı tasarım ve package/ownership gate gerekir.

## Deney manifesti

`schemaVersion`, source repo/commit/dirty state, fixture digest, split identity, frame identity (repo/branch/environment/task), seed, mechanism flags, budget, measurement version ve threshold config hash deneyden önce kilitlenir. Baseline ile candidate aynı görev/split/bütçeyi kullanır. Train/holdout/transfer kimlikleri ve aynı olaydan türetilmiş örnekler çakışamaz.

Budget model/tool/human çağrı sayısı, token, wall time ve varsa compute'ı ayrı taşır. Birimleri tanımlanmamış bileşik maliyet skoru üretme. Sayaç yoksa unknown; candidate'a gizli ek çağrı yok. Stochastic repetition sayısı yeterlilik sözleşmesine bağlıdır; deterministic testin tek tekrarı confidence interval iddiası değildir.

Outcome statüleri: observed verified success, observed failure, contradicted, censored/missing, measurement_error. Attempt/eligible/observed sayımları ayrı tutulur. Belief posterior veya verify verdict certainty doğrudan outcome prediction p olamaz. Bu ilk dilimde uygun prediction p yoksa Brier/ECE `NOT_MEASURED`; V0.2 açık p/outcome pairing'i sağlar.

## Testleri önce yaz

1. Baseline-vs-baseline deterministic sonuç digest'i aynı; zaman gibi nondeterministic alanlar correctness digest'inden açıkça ayrılır.
2. Duplicate source/event ve counter/support invalidation senaryolarında baseline'ın gerçek davranışı değiştirilmeden ölçülür. Engine duplicate desteği sayıyor veya support invalidation'ı eksik yapıyorsa `KNOWN_LIMITATION` / benchmark başarısızlığı raporlanır; evaluator bunu doğru saptadığında kendi testi PASS olabilir. Fixture'ları önceden dedup ederek baseline eksikliği gizlenmez. Hedef engine davranışı I0 adayının gate'idir. Yalnız istatistik hesabında correlated örneklerin independent sample sayılmaması V0.1 evaluator sorumluluğudur.
3. Holdout leakage ve farklı budget ile candidate koşumu reject edilir.
4. Missing/censored outcome success denominator'ına sessizce sokulamaz; verisizlik `INSUFFICIENT` olur.
5. NaN/Infinity/schema mismatch, broken run hash ve tam olmayan measurement fail-closed terfi engeli verir.
6. Forged observation veya callback error gerçek verified success olamaz; reported effect observed effect sayılmaz.
7. Unsafe proposal blocked ise engelleme kaydı görünür; gerçekten bypass/state mutation varsa integrity REJECT olur.
8. Evaluator bypass mutantları (overlap check off, missing→success, budget ignored, bypass ignored) kırmızı test üretir; suite sadece implementation aynası olmamalı.

## Karar sözlüğü

Gain sonucu ile integrity sonucu ve activation durumu ayrıdır. Dokuz gain boyutu raporda bulunur; B1 ölçülür, B2–B8 `NOT_MEASURED`. Manifest/evaluator karakterizasyonu PASS olduğunda çıktı **ölçüm altyapısı baseline'ı karakterize edildi** olur; **intelligence gain PASS** olmaz.

Candidate'ın meaningful effect eşiği ve non-inferiority toleransı deney öncesi ayrı mekanizma manifestinde belirlenir. Ölçümden sonra eşik değiştirerek sonucu PASS yapma. Önce pilot sample yeterliliği değerlendir; 100 experience/20 unseen task bütün alanlar için evrensel kabul sayısı değildir.

## Kabul komutları

Uygulama tesliminde aşağıdaki önerilen girişler gerçek ve çalışır hale gelmeli:

```powershell
node --test test/cognitive-lab-contract.test.js test/cognitive-lab-baseline.test.js
node scripts/cognitive-lab/run.js --benchmark=B1 --baseline-only
node scripts/architecture-snapshot.js --check --base-ref=<fresh-main-sha>
npm run check:cycles
npm run check:module-boundary
npm run check:layers
npm run check:file-size
npm run check:package-closure
```

İlk komut negatiflerle birlikte fail0 olmalı; ikincisi B1, source/split/budget/evidence ve B2–B8 NOT_MEASURED göstermeli. Manifest schema'da başka bir flag stili tercih edilirse komutlar aynı PR'da güncellenir; mevcutmuş gibi belgelenmez. Sonra değişiklik için gerekli repository test/CI gates uygulanır; full suite istenirse seçilmiş test green yerine sayılmaz.

## Kapsam dışı ve sonraki işler

Yeni scheduler/causal/world/neural engine, production procedure promotion, gate threshold ayarlama, policy widening, foundation model training, release/env/wire migration, public deployment bu dilimde yok. V0.2 paired probability/outcome, I0 evidence candidate, I2 qualification wiring, I1 scheduler ablation, L0/L1 Semantic IR ayrı iş paketleridir. Tam program ve bütün kaynak alanları ana planda ve gereksinim matrisinde açık kalır.

## İki dakikalık göz testi

Bir baseline run JSON'u aç: source SHA ve fixture digest doğru; eligible/observed/censored ayrımı görünür; B1 result evidence taşır; B2–B8 NOT_MEASURED. Aynı baseline yeniden koşulduğunda correctness digest aynı. Holdout ID'sini training'e kopyalayan fixture ile evaluator reject verir. Bu görev paketi bugün bu komutların uygulanmış olduğunu iddia etmez.

```text
[BAĞLAM] HUQAN 0.12.0, ölçülebilir reasoning/learning önceliği; mevcut primitive'ler yeniden kullanılacak.
[GÖREV] V0.1 offline Cognitive Lab manifest/evaluator + gerçek B1 baseline.
[KABUL] Negatif/mutation testleri evaluator bypass'ını kırar; baseline replay aynı; trust regression yok; B2–B8 NOT_MEASURED; ilgili gates PASS.
[YASAK] Yeni authority/receipt/policy/schema-wire, otomatik activation, training-holdout overlap, release değişimi.
[SÜRÜM] Plan tabanı 83000331c07e4c9bb592dfc75b12851d3aa3ee8a; implementation yeni canlı main tabanını yeniden doğrular.
```
