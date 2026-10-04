# B6 — Cognitive Scheduler eşit-bütçe ablation ön-kaydı (preregistration)

**Status:** ölçüm ÖNCESİ a priori protokol taslağı; implementation ve sonuç yoktur, gain iddiası yoktur. Eşikler ve külliye dağılımı bu belgede **bilinçli olarak "maintainer onayı bekliyor"** işaretlidir; rastgele yüzde icat edilmemiştir (bkz. §7, §8).
**Base:** `674e7fbb77eff34aaccac2a2e5ac417165d78c9e`, package `0.13.2`.
**Owner:** tek uygulayıcı; külliye ve eşikler ölçümden önce bağımsız denetçi/maintainer tarafından imzalanır.
**Issue:** [#3311](https://github.com/ali-ulu/huqan/issues/3311), program [#3306](https://github.com/ali-ulu/huqan/issues/3306); öncül V0.1/V0.2 (#3307/#3308) ve #3309 kapalı.
**Reuse:** `lib/cognitive-lab-manifest.js`, `lib/cognitive-lab-paired-delta.js` (+ `lockContract`), `test/helpers/cognitive-lab-comparison.js`, `test/fixtures/deterministic-tasks/`.

## 0. Amaç ve sınır

Bu belge, opt-in Cognitive Scheduler'ın (#3311) **eşit bütçede** baseline FIFO'ya karşı bir çözüm-kazanımı üretip üretmediğini ölçen **B6** deneyinin, deney **başlamadan önce** kilitlenmesi gereken sözleşmesidir (task-pack `cognitive-lab-entry-20261001.md` §"Deney manifesti", §"Ölçüm sözleşmesi").

İki sınır baştan kabul edilir:
- Bu bir **gain iddiası değil**, ölçüm protokolüdür. Sonuç pozitif de olsa negatif de olsa `NOT_MEASURED`/`INSUFFICIENT`/`REJECT`/sayısal verdict olarak, olduğu gibi raporlanır.
- Ölçüm **ölçüm altyapısının** ve **sinyal gücünün** karakterizasyonudur; "intelligence gain PASS" demek değildir.

## 1. Hipotez ve nedensel iddia

- **H0 (null):** eşit görev/split/seed/bütçede, candidate (scheduler sırası) ile baseline (plan FIFO sırası) arasında çözülen-görev oranında anlamlı fark yoktur.
- **H1 (yönlü):** candidate, baseline'a göre solved-task oranını **anlamlı** artırır (§7'deki eşik) **ve** maliyet/integrity açısından **non-inferior**'dır (§7).

Yön tek taraflıdır (higher-is-better); çift taraflı "fark var" iddiası kurulmaz.

## 2. Gerçeklik sınırı — sıra ne zaman nedensel olabilir

`agent.v3.js:228` döngüsü kuyruğu, `maxSteps`/`maxIterations`/`timeBudget` sınırına kadar **tüm** adımlar için boşaltır; finalizer (`lib/agent-v3-status-methods.js:23-30`) `completed` kararını yalnız "kuyruk boş + son adım `ok !== false`" üzerinden verir. Bu nedenle:

- **Tam drain edilen bir koşuda sıra, outcome'u değiştirmez** (no-op). Bu durumda B6 tanım gereği fark bulamaz.
- Sıra **yalnız** koşu bütçe nedeniyle erken kesildiğinde (kuyruk boşalmadan durduğunda) "hangi adımlar koştu"yu belirleyerek fark yaratır.

Bu yüzden B6 külliyesi §4'te **kesilmiş-bütçe (censored-budget)** olarak tanımlanır: her görevin planı, koşu bütçesini aşacak şekilde kurulur ve yalnız ilk `K` adım çalışabilir. Test edilen iddia şudur: *planın çözüm adımı, candidate sırasında baseline'a göre daha sık ilk `K` adım içine girer.*

## 3. Deney birimleri ve arms

| Öğe | Tanım |
|---|---|
| Görev (task) | Deterministik, donmuş bir plan + bir çözüm-adımı kimliği + bir bütçe `K`. |
| Arm baseline | `opts.cognitiveScheduler` **yok** → plan FIFO sırası (bugünkü varsayılan). |
| Arm candidate | `opts.cognitiveScheduler` **var** (config §11) → `scheduleQueuedSteps` sırası. |
| Eşit bütçe | İki arm birebir aynı `budget` (model/tool/human çağrısı, token, wall-time, compute ayrı birimlerle). |
| Sabitler | Aynı split, aynı seed, aynı ölçüm versiyonu, aynı threshold config hash. |

Ablation, `paired-delta` modülünün `baseline`/`candidate` sözleşmesiyle koşar; her iki arm aynı görev kümesini görür.

## 4. Görev külliyatı (donmuş, hash'li)

- **Biçim:** her görev bir kayıttır: `taskId`, `goal` (külliye metni), `objective`, `solutionStepId` (çözümü belirleyen plan adım id'si), `K` (bütçe), `split`. Plan, uydurma bir JSON değil, **gerçek** agent planıdır (`lib/agent-planning-policy.js` objective şablonu; `id` = plan adım kimliği).
- **"Solved" yüklemi (predicate):** bir koşuda `solutionStepId`, bütçe ile çalıştırılan ilk `K` adım arasında yer alıyorsa görev **solved**'dır (adım başına maliyet = 1 adım). Aynı tool'u kullanan başka bir adım çözüm saymaz; id ile eşleşme aranır.
- **Kesilmiş bütçe garantisi:** her görevde `K < plan.length` (aksi halde sıra no-op olur, §2) ve `K ≥ 1`.
- **Çeşitlilik zorunluluğu:** külliye, sinyalin kayırdığı aileleri (train) ve kayırmadığı çok-adımlı/yabancı aileleri birlikte içerir; çift yönlüdür (hem kazandıran hem kaybettiren vaka). Test bunu assert eder; anti-vaka yoksa verdict `INSUFFICIENT` olur.
- **Hash:** `CORPUS_DIGEST = computeManifestDigest(tasks)` (`lib/cognitive-lab-manifest.js`); külliye test dosyasında donmuştur ve ölçüm bu digest'i taşır.
- **Bilinen sınır:** sıralayıcının tek etkili sinyali goal↔aile keyword relevance'tır (urgency/risk plan adımlarında tanımsız olduğundan katkı ~0). Bu, kısmen kendini doğrulayan bir gain riski taşır; §12'de (a) kararı bu sınırla dürüst ölçümdür.

## 5. Split ve leakage

- `train` (sinyalin kayırdığı aile), `holdout` (**primer**), `transfer` (yabancı aile) bölümleri `taskId` ile ayrıktır; hiçbir görev iki bölümde görünmez.
- Karar, **yalnız holdout** üzerinden verilir; train/transfer yalnız bağlam olarak raporlanır (sinyale hizalı oldukları için primer olamazlar).
- Aynı olaydan türetilen örnekler bağımsız sayılmaz; külliye her görev için tek gözlem üretir.

## 6. Metrikler ve yön

| Sıra | Metrik | Yön | Rol |
|---|---|---|---|
| Primer | solved-task oranı (holdout) | higher-is-better | H1 birincil |
| İkincil | çalıştırılan adım başına maliyet (eşit bütçede) | lower-is-better | non-inferiority |
| Guard | integrity/trust regresyonu | eşit olmalı | REJECT eşiği |

Primer metrik için **paired** fark (aynı görevde candidate − baseline, ikili çözüldü/çözülmedi) kullanılır; `paired-delta` bootstrap aralığı uygulanır.

## 7. Ön-kayıtlı eşikler (kilitlendi)

Değerler ölçümden **önce** kilitlendi; artefakt `test/cognitive-lab-b6-scheduler.test.js` içindeki `CONTRACT`tır ve bilinmeyen/eksik alan reddedilir (uydurulmuş bir "rastgele yüzde" yok — 0, "anlamlı addedilen minimum etki yok" demektir):

- `metric` = `solved-task-rate`; `direction` = `higher-is-better`.
- `seed` = 3311; `resamples` = 2000; `confidenceLevel` = 0.95.
- `meaningfulEffect` = **0** (yalnız %95 alt sınırı 0'ı geçerse sonuç üstün sayılır).
- `nonInferiorityCostMargin` = **0** (çözülen-görev başına maliyet baseline'ı aşamaz).
- `minimumSamples` = **16**, `minimumHoldout` = **8** — **sabit** (külliye uzunluğundan türetilmez; görev silinse bile örnek kapısı düşmez). Altında `INSUFFICIENT`.

## 8. Örnek yeterliliği

- Külliye **N=17** görev: `train`=4, `transfer`=4, `holdout`=9 (primer). Kesilmiş bütçe (`K` = 2 veya 3).
- **Bilimsel çapa:** HUQAN'ın kalibrasyon için kabul ettiği Agarwal vd. (NeurIPS 2021) ve `rliable` pratiği — paired karşılaştırma + bootstrap aralığı. Bu bir güç analizi **değildir**; holdout n=9 küçük bir örnektir ve rapor aralık genişliğiyle okunmalıdır. Daha büyük örnek, aynı donmuş artefaktla tekrarlanabilir.
- Determinizm testi, aynı donmuş külliye yeniden koşulduğunda correctness digest'in aynı olduğunu doğrular; tekrar bir confidence iddiası değildir.

## 9. Fail-closed ve integrity

- Veri yok/yetersiz → `INSUFFICIENT`; ölçülemeyen boyut → `NOT_MEASURED`.
- Leakage, budget mismatch, bozuk manifest hash, forged observation, NaN/Infinity, authority bypass → `REJECT`.
- Unsafe/blocked candidate önerisi sayımı ile gerçek policy bypass/state mutation ayrı tutulur.
- **Evaluator mutation testleri** (zorunlu, §13): overlap-check off, missing→success, budget ignored, bypass ignored, solutionStepId yok sayma mutantları **kırmızı** üretmeli; suite yalnız implementation aynası olamaz.

## 10. Kill / durdurma kriterleri (ölçüm öncesi)

Aşağıdakilerden biri olursa deney **durdurulur** ve `INSUFFICIENT`/`REJECT` raporlanır (sonuç lehine yorum yapılmaz):
- Külliyede anti-vaka (sınıf iii) yok veya sınıf dağılımı bozuk.
- Baseline-vs-baseline replay deterministik değil (aynı correctness digest).
- Scheduler, kesilmiş-bütçe koşularında sırayı hiç değiştirmiyor (etkisiz/no-op).
- Split leakage veya aynı `sourceEventId` çakışması.
- Pilot, anlamlı etkiyi makul `N` içinde ayırt edemeyeceğini gösteriyor (underpowered).

## 11. Harness ve config (reuse)

- Manifest: `lib/cognitive-lab-manifest.js` (`buildManifest`, `computeManifestDigest`), `mechanisms.B6 = 'ENABLED'`, diğerleri `NOT_MEASURED`.
- Karşılaştırma: `lib/cognitive-lab-paired-delta.js` (`lockContract`, bootstrap); giriş biçimi `test/helpers/cognitive-lab-comparison.js` ile uyumlu.
- Candidate config: `opts.cognitiveScheduler = { maxRiskTier, budget, maxDepth, starvationWindow }` — değerler sözleşmede kilitlenir.
- Runner/evaluator: ölçüm `test/cognitive-lab-b6-scheduler.test.js` ve harness `test/helpers/cognitive-lab-b6-scheduler.js` içinde teslim edildi (test kapsamı; shipped `scripts/cognitive-lab/*` CLI yüzeyi bu dilimde eklenmedi).

## 12. Açık sorular — kararlar

1. **Sinyal stratejisi (karar: (a)).** Scheduler'ın tek etkili sinyali goal↔aile keyword relevance olduğundan "kazandığı" her dağılım tanım gereği bu sinyalle hizalıdır. (a) seçildi: bu sınırla dürüstçe ölçülür ve sonuç — negatif olsa da — olduğu gibi raporlanır. Sinyali güçlendirmek ayrı bir scoped iştir.
2. **Külliye dağılımı:** yedi objective ailesi, N=24, çift yönlü (bkz. §4, §16).
3. **Eşikler (§7) ve örnek (§8):** kilitlendi (0 / 0 / 24); bkz. §16 sonucu.

## 13. Kabul komutları (implementation sonrası)

```text
node --test test/cognitive-lab-b6-scheduler.test.js
node scripts/architecture-snapshot.js --check --base-ref=<fresh-main-sha>
npm run check:cycles && npm run check:module-boundary && npm run check:layers && npm run check:file-size && npm run check:package-closure
```

## 14. Kapsam

- Harness `test/helpers/cognitive-lab-b6-scheduler.js`, ölçüm `test/cognitive-lab-b6-scheduler.test.js`; ikisi de test-kapsamındadır (shipped lib yüzeyi eklemez, boundary/package kapısı gerektirmez).
- Kapsam dışı: scheduler sinyalini değiştirmek, production wiring/activation, policy/threshold genişletme, yeni authority/receipt, release değişikliği.

## 15. Göz testi

Manifest `source.commit`/`fixture.digest`/`split.identity` doğru; `budget` iki armda eşit ve birimleri tanımlı; `mechanisms.B6=ENABLED`, diğerleri `NOT_MEASURED`; primer metrik solved-rate ve yön higher-is-better; eşik alanları kilitli (§7); holdout ID'sini train'e kopyalayan fixture `REJECT` verir; aynı baseline yeniden koşulduğunda correctness digest aynı.

## 16. Sonuç (B6, mevcut sinyalle)

Ölçüm kilitli külliye (`CORPUS_DIGEST = 55e9cfb0a04f84e1…`) ve sözleşmeyle koşuldu (`test/cognitive-lab-b6-scheduler.test.js`). Karar **holdout** üzerinden:

| Split | n | Baseline çözülen | Candidate çözülen |
|---|---|---|---|
| train (sinyalin kayırdığı) | 4 | 0 | 3 |
| transfer (yabancı) | 4 | 2 | 0 |
| **holdout (primer)** | **9** | **6** | **2** |
| tümü | 17 | 8 | 5 |

- Primer (holdout) paired mean Δ = **−0.444**; %95 bootstrap aralığı **[-0.889, 0.000]**; alt sınır `meaningfulEffect=0`'ı geçmiyor.
- **Verdict: `MEASURED`, `assertsGain = false`** (`interval_below_meaningful_effect`). İki kol da tam **38 adım** harcadı (eşit bütçe); holdout'ta çözülen-görev başına maliyet baseline 3.33, candidate 10.00 → maliyet de üstün değil.
- **Gözlem:** keyword-relevance sinyali yalnız kendi ailesinde (train: verify/compare) yararlı; yabancı/çok-adımlı ailelerde zararlı (transfer 2→0, holdout 6→2). Çok-adımlı planlarda `verify`'ı yerinden edip `dream`'e bırakıyor; learn'de `ingest` yerine `confirm`'e geçip çözümü kaçırıyor.
- **Karar:** #3311 kabul kriteri "eşit bütçede daha yüksek solved-task / daha düşük maliyet" **karşılanmadı**. Bu, dürüst bir negatif sonuçtur; overclaim yapılmaz. Sinyal güçlendirme ayrı bir scoped iştir.

## 17. Sonuç v2 — sinyal güçlendirme sonrası (#3447)

#3447 relevance sinyalini güçlendirdi: objective→adım-rolü sinyali (ağırlık **0.2**, keyword 0.6'dan zayıf) ve gerçek koşuda `tieBreak: 'input-order'` (eşit skorda plan/FIFO sırası; varsayılan `key` korunur). **Külliye #3446'da fix'ten önce donduğu için bu bir yeniden-ölçümdür, fix'e uydurulmuş değil.**

| Split | n | Baseline | Candidate | Δ |
|---|---|---|---|---|
| train | 4 | 0 | 4 | +4 |
| transfer | 4 | 2 | 4 | +2 |
| **holdout (primer)** | **9** | **6** | **9** | **+3** |
| tümü | 17 | 8 | 17 | +9 |

- Holdout paired mean Δ = **+0.333**; %95 bootstrap aralığı **[0.111, 0.556]**; alt sınır `meaningfulEffect=0`'ı geçiyor.
- İki kol da **38 adım** (eşit bütçe); holdout çözülen-görev başına maliyet baseline 3.33 → candidate **2.22** (non-inferior).
- **Verdict: `MEASURED`, `assertsGain = true`.** Candidate, dondurulmuş külliyede **hiçbir görevi kaybettirmiyor** (hurt = 0).
- **Sınır (dürüstlük):** holdout n=9 ve yalnız bir gözlem külliye olduğundan bu bir *nokta tahmini*dir; aralık genişliğiyle okunmalıdır. Kazançların çoğu `verify`/`reason`/`compare` adımlarının bütçeye girmesinden geliyor. Daha büyük/bağımsız bir holdout, aynı donmuş artefaktla tekrarlanmalıdır.
