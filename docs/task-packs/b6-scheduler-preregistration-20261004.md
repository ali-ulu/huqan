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

- **Biçim:** her görev bir JSON kaydıdır: `taskId`, `sourceEventId`, `split`, `goal` (külliye metni), `plan` (sıralı adım listesi; her adım `{id, tool, input}`), `solutionStepId`, `budget.toolCalls = K`, `familyMatrix` (aile×konum).
- **"Solved" yüklemi (predicate):** bir koşuda `solutionStepId`, bütçe ile çalıştırılan ilk `K` adım arasında yer alıyorsa görev **solved**'dır. Aksi halde unsolved. (Adım başına maliyet = 1 tool-call; `K` = adım sayısı sınırı.)
- **Kesilmiş bütçe garantisi:** her görevde `plan.length > K` (aksi halde sıra no-op olur, §2) ve `K ≥ 1`.
- **Körlük (blind):** külliye üreticisi, hangi arm'ın lehine olduğunu hesaplamaz; görevler family×konum matrisi üzerinden **deterministik seed** ile üretilir, elle seçilmez. Her görev yalnız `split` etiketiyle sınıflanır.
- **Çeşitlilik zorunluluğu:** külliye üç sınıfı da içerir — (i) FIFO'nun zaten çözdüğü, (ii) FIFO'nun kaçırdığı, (iii) sıra-değişiminin çözümü bütçe dışına itebildiği (anti-vaka). Anti-vaka yoksa gain ölçümü tek yönlü/rigged sayılır ve verdict `INSUFFICIENT` olur.
- **Hash:** `fixture.digest` = `computeManifestDigest(tasks)`; külliye dosyası deneyden önce commit'lenir ve değiştirilemez.
- **Bilinen sınır:** sıralayıcının tek etkili sinyali goal↔aile keyword relevance'tır (urgency/risk plan adımlarında tanımsız olduğundan katkı ~0). Bu nedenle külliye, çözüm-adımı ailesi ile goal sözcükleri arasındaki ilişkiyi **çeşitlendirir**; tüm çözüm adımlarını goal'da adı geçen aileye koymak rigged olur ve yasaktır (bkz. §12).

## 5. Split ve leakage

- `train` (sinyal/sözleşme kontrolü), `holdout` (primer), `transfer` (ikincil) bölümleri `taskId` ile ayrık; aynı `sourceEventId` hiçbir iki bölümde görünmez.
- Holdout/transfer kimliği eğitime (külliye üretimi/ayar) sızmaz; sızma `REJECT` (§9).
- Aynı olaydan türetilen örnekler bağımsız sayılmaz; istatistikte tekilleştirilir.

## 6. Metrikler ve yön

| Sıra | Metrik | Yön | Rol |
|---|---|---|---|
| Primer | solved-task oranı (holdout) | higher-is-better | H1 birincil |
| İkincil | çalıştırılan adım başına maliyet (eşit bütçede) | lower-is-better | non-inferiority |
| Guard | integrity/trust regresyonu | eşit olmalı | REJECT eşiği |

Primer metrik için **paired** fark (aynı görevde candidate − baseline, ikili çözüldü/çözülmedi) kullanılır; `paired-delta` bootstrap aralığı uygulanır.

## 7. Ön-kayıtlı eşikler — **MAINTAINER ONAYI BEKLİYOR**

Bu değerler bilinçli olarak **boş bırakılmıştır**; uydurulmaz ve ölçümden sonra seçilmez (task-pack "rastgele yüzde icat edilmez"). Onaylanan değerler `thresholdConfigHash`'e girer ve commit'lenir:

- `metricDirection` = higher-is-better (primer).
- `meaningfulEffect` = **<onay>** (solved-rate paired farkı için anlamlı etki eşiği).
- `nonInferiority` = **<onay>** (maliyet ve integrity için tolerans; 0 = katı non-inferiority önerisi).
- `uncertainty` = paired-bootstrap-percentile, `confidence` = **<onay>** (0.95 önerisi), `resamples` = **<onay>**.
- `alpha` = **<onay>**.
- `minObserved` = **<onay>** (veri yoksa `INSUFFICIENT`).

## 8. Örnek yeterliliği ve güç — **MAINTAINER ONAYI BEKLİYOR**

`100 experience / 20 unseen task` PDF örneğidir, evrensel PASS sayısı değildir (task-pack). Bu deney için:

- **Önerilen bilimsel çapa (uydurma değil):** HUQAN'ın kalibrasyon için zaten kabul ettiği Agarwal vd. (NeurIPS 2021, küçük örneklemde ölçüm belirsizliği) ve `rliable` pratiği — *paired* karşılaştırma, bootstrap aralığı, örnek yeterliliğinin **önceden** pilot ile değerlendirilmesi.
- **Süreç:** (a) pilot `N0` görevle çözüm oranı ve paired-varyans kestirilir; (b) hedef güç `1−β` ve `alpha`'ya göre gereken `N` **bu pilot verisiyle** hesaplanır ve dondurulur; (c) holdout `N`'e tamamlanır. Pilot holdout'a karışmaz.
- **Değerler** (`N0`, hedef güç, son `N`, split başına görev sayısı) **<onay>**.
- Deterministik fixture'ın tek tekrarı confidence-interval iddiası değildir; tekrar sayısı ve seed seti sözleşmeye bağlanır.

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
- Runner/evaluator: `scripts/cognitive-lab/run.js` + `scripts/cognitive-lab/evaluate.js` (task-pack'te önerilen; henüz yok) — bu PR'da **implement edilmez** (bkz. §14).

## 12. Açık sorular — maintainer kararı

1. **Sinyal gücü (kritik):** scheduler'ın tek etkili sinyali goal↔aile keyword relevance olduğundan, "kazandığı" her dağılım tanım gereği bu sinyalle hizalıdır. Bu, kısmen kendini doğrulayan bir gain riski taşır. Seçenek: (a) bu sınırla dürüstçe ölçüp sonucu — muhtemelen dar/`NOT_MEASURED` — raporlamak; (b) önce scheduler sinyalini güçlendirmek (ayrı scoped iş) ve B6'yı ondan sonra koşmak.
2. **Külliye dağılımı:** family×konum matrisinin büyüklüğü ve sınıf oranları (§4) onaylanmalı.
3. **Eşikler (§7) ve örnek (§8)** onaylanmalı.

## 13. Kabul komutları (implementation sonrası)

```text
node scripts/cognitive-lab/run.js --benchmark=B6 --baseline-only
node --test test/cognitive-lab-b6-scheduler.test.js
node scripts/architecture-snapshot.js --check --base-ref=<fresh-main-sha>
npm run check:cycles && npm run check:module-boundary && npm run check:layers && npm run check:file-size && npm run check:package-closure
```

## 14. Bu ön-kaydın kapsamı ve kapsam dışı

- **Bu belge kod içermez.** Runner/evaluator, külliye dosyaları ve testler, §7/§8 onaylandıktan sonra ayrı PR(lar)da teslim edilir.
- Kapsam dışı: scheduler sinyalini değiştirmek, production wiring/activation, policy/threshold genişletme, yeni authority/receipt, release değişikliği.

## 15. Göz testi

Manifest `source.commit`/`fixture.digest`/`split.identity` doğru; `budget` iki armda eşit ve birimleri tanımlı; `mechanisms.B6=ENABLED`, diğerleri `NOT_MEASURED`; primer metrik solved-rate ve yön higher-is-better; eşik alanları ya onaylı bir değer ya da açıkça `PENDING-MAINTAINER`; holdout ID'sini train'e kopyalayan fixture `REJECT` verir; aynı baseline yeniden koşulduğunda correctness digest aynı.
