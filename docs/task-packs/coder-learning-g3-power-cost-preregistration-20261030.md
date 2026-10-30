# Coder öğrenme kazanımı — G3 güç ve tekrarlı maliyet ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi; §5 (güç) ve §7 (eşik) bu commit ile
donduruldu. Ölçüm bu commit'ten **sonra**, aynı PR'da koşulur ve sonuç ayrı bir
belgede raporlanır (`coder-learning-g3-power-cost-result-20261030.md`).

**Base:** `ebc4dd31` (origin/main). **Issue:** [#4416](https://github.com/ali-ulu/huqan/issues/4416).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki ölçüm:** `docs/task-packs/coder-learning-g3-cohort-preregistration-20261030.md`
ve sonucu (#4380 / PR #4414). O kohort **tüketildi**: holdout görevleri, corpus digest'i ve
eğitim fixture'ları burada **tekrar kullanılmaz**. Bu belge yeni bir koşum dilimidir.
**Biçim/güç referansı:** M9 holdout ön-kaydı (`cog-m9-holdout-preregistration-20261029.md`),
`lib/cognitive-lab-m9-holdout.js::requiredSample`.

## 0. Amaç ve sınır

#4416, G3 kapanış kapısının (`docs/cognitive-architecture-plan.md` §G3) iki eksik
koşulunu ölçer:

1. **Güç:** örnek sayısı, ilan edilmiş asgari anlamlı etki ve güç hesabıyla gerekçelenmeli
   (küçük örnek yalnız pilot/karakterizasyondur).
2. **Tekrarlı maliyet:** maliyet tek bir platforma duyarlı koşum değil, **yinelemeli**
   (duvar-saati dağılımı) ve CPU'nun da ölçüldüğü bir kayıt olmalı; `GAIN` iddiası için
   CPU `NOT_MEASURED` kalamaz.

Sınırlar:
- Bu, mevcut Coder davranışının **ölçümüdür**; runtime kod değişikliği yoktur. Değişen
  dosyalar yalnızca bu ön-kayıt belgesi, ortak fixture helper'ı, eval testi ve sonuç
  belgesidir. `lib/` altında hiçbir dosya değişmez.
- Genel öğrenme/`intelligenceGain` iddiası çıkarılmaz. Bulgu, iki aileli sabit grammar
  üzerinde paired transfer ölçümüdür.
- Bulunan bir boşluk (ör. duvar-saati kazancı çıkmaması) **kapatılmaz**; ölçülür ve
  raporlanır.

## 1. Hipotezler

- **H0:** Paired process kazancı örnek sayısına duyarlıdır (güç yetmez) veya maliyet
  ölçümü yinelemeler arasında oynaktır (dağılım geniş); CPU ölçülemez.
- **H1 (yönlü):**
  - **H1a (güç):** paired process kazancı için hesaplanan `requiredSample`, mevcut
    kalibrasyon diliminin sağladığı `sigma` altında **karşılanabilir** (`powerMet = true`),
    yani örnek yeterlidir.
  - **H1b (yinelemeli maliyet):** duvar-saati kazancı yinelemeler arasında **kararlı işaret**
    gösterir (aynı verdict) ve dağılım dar (yinelemeler arası verdict değişmez).
  - **H1c (CPU):** CPU maliyeti ölçülür (`NOT_MEASURED` değil) ve baseline vs learned
    yönü raporlanır.

Not: H1a, H1'in *ölçüm kalitesi* koludur — "process kazancı var" iddiasını değil, "bu
kohort o iddiayı taşıyacak güçte mi" sorusunu yanıtlar. Process kazancının kendisi
#4380'de ölçülmüştür ve burada yeniden ölçülmez; güç hesabının girdisi olur.

## 2. Gerçeklik sınırı

Ölçüm `cli.js coder <task> --synthesize / --adapt-memory` gerçek giriş noktası üzerinden,
gerçek geçici Git depolarında koşar. Süreçler `spawnSync` ile gerçek çocuk process'tir.

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Taze kök; görevler `--synthesize` ile. |
| Learned kol | Eğitim görevi `--synthesize` + `rememberFile`; sonra görevler `--adapt-memory`. |
| Kalibrasyon dilimi | Holdout'tan **ayrı** görevler (§4); `sigma` buradan, holdout açılmadan ölçülür. |
| Eşit bütçe | Her iki kol `CONTRACT.budget = 8`; aynı görev hash'leri, aynı test komutları. |

## 4. Külliyat (ölçümden önce kilitlendi)

#4380 kohortundan **ayrı** bir dilim. Aileler aynı grammar'dır ama görev kimlikleri,
parametre adları ve örnek/check değerleri farklıdır (leakage yok).

**Kalibrasyon dilimi (σ kaynağı; holdout değil):** `calib-a`, `calib-b`, `calib-c`
(`arithmetic-expression`, buggy `x => x + 1`, hedef `x % 2`). Bu görevler **yalnız** `sigma`
hesabına girer; holdout görevleri ayrıdır.

**Holdout (N = 5 / aile):**
- Aile A `arithmetic-expression`: `pow-one`, `pow-two`, `pow-three`, `pow-four`, `pow-five`.
- Aile B `string-expression` (buggy `p.toUpperCase()`, hedef `p.trim().toLowerCase()`):
  `fold-one`, `fold-two`, `fold-three`, `fold-four`, `fold-five`.

**Eğitim:** Aile A `train-a` (`n`, `[0,2,4]`, check `[5,8]`); Aile B `train-b`
(`clean`/`value`, küçük harfli sentez örnekleri, büyük harfli test). Learned kök eğitim
görevlerini `--synthesize` + `rememberFile` ile koşar; holdout görevleri `--adapt-memory` ile.

**Yazma bütünlüğü:** her paired koşumda ağaç değişimi yalnız görevin kendi kaynak dosyası
olmalı; her sapma sayılır (`wrongWrites`), `wrongWriteTolerance = 0`.

**Hash:** her görevin `taskHash`/`testHash`'i (sha256) raporlanır; kollar arası birebir eşitlik
assert edilir.

**Kapsam notu:** #4380'in anti-vakaları (farklı-aile aktarım reddi, farklı-yöntem rollback,
önceki-beceri non-inferiority, restart kalıcılığı) bu dilimde **yeniden ölçülmez**; onlar
#4380 kohortunda kanıtlandı ve bu ölçümün konusu güç + tekrarlı maliyettir (bkz. §11).

## 5. Güç hesabı (dondurulmuş)

Güç, üç maliyet/etki boyutu için ayrı ayrı hesaplanır; cohort büyüklüğü **process**
boyutunun gerektirdiği örnekle gerekçelenir (birincil, deterministik metrik).

- **Boyutlar ve ilan edilmiş asgari anlamlı etki (dondurulmuş):**
  - `process`: `MIN_EFFECT = 1.0` process (bir doğrulama process'inin tasarrufu).
  - `wallMs`: `MIN_EFFECT = 100` ms (anlamlı sayılan duvar-saati tasarrufu).
  - `cpuMs`: `MIN_EFFECT = 100` ms (anlamlı sayılan CPU tasarrufu).
- **Güç (dondurulmuş):** `alpha 0.05` / `power 0.8` → `z_alpha 1.96`, `z_power 0.84`.
- **sigma:** her boyut için, kalibrasyon diliminin (§4) eşli deltalarından örnek standart
  sapması (`n − 1` paydalı), **holdout açılmadan** ölçülür.
- **Örnek formülü (dondurulmuş):** M9 ile aynı —
  `requiredSample(m) = max(CONTRACT.minimumSamples, ceil(((z_alpha + z_power) * sigma(m) / MIN_EFFECT(m))^2))`.
- **`CONTRACT.minimumSamples = 10`** (M9 ile aynı taban; altında `INSUFFICIENT`).
- **`powerMet(m)`** = `holdoutSize >= requiredSample(m)`.
- Cohort büyüklüğü: `holdoutPerFamily = 5` → `holdoutSize = 10`, process boyutunun
  `requiredSample`'ını (asgari taban) karşılayacak şekilde seçildi. `minimumSamples` altına
  düşen bir cohort `INSUFFICIENT`'tır; küçük örnek "kanıt" gibi sunulmaz.
- `requiredSample`, `sigma`, `powerMet` her boyut için raporun kilit tablosundadır. Duvar-saati
  boyutu bu örnekte güçsüz çıkarsa bu bir **bulgu**dur (platform başına verdict kaymasını
  açıklar); process boyutu yeterliyse güç kapısı geçer.

## 6. Tekrarlı maliyet protokolü (dondurulmuş)

- **Tekrar sayısı:** `CONTRACT.repeats = 3`. Her tekrar, aynı fixture'lar üzerinde **tam**
  paired (baseline + learned + eğitim) koşumudur; fixture'lar her tekrarda taze kökte kurulur.
- **Ölçülen boyutlar (her tekrar):**
  - duvar-saati: `process.hrtime.bigint()` ile; baseline/learned/eğitim ayrı.
  - **CPU:** çocuk process başına `user + system` ms ve `maxRSS` (yeni bağımlılık yok;
    `NODE_OPTIONS=--require <probe>` ile her node alt-süreç kendi `process.cpuUsage()` /
    `resourceUsage()` değerini bir JSONL'e yazar; CLI'ın kendi `test.command` spawn'ları dahil).
  - process sayıları (deterministik kapı; yinelemeler arası değişmezlik assert edilir).
- **Raporlanan:** her boyut için `min / median / max` ve yinelemeler arası verdict kararlılığı.
- **CPU fail-closed:** probe herhangi bir tekrarda kayıt üretemezse (dosya yok/boş veya
  `NaN`) ya da bir koşumun satır sayısı spawn edilen process sayısından (`processes + 1`)
  azsa, CPU boyutu `NOT_MEASURED` olur ve `GAIN` iddiası kurulamaz.

## 7. Ön-kayıtlı eşikler (ölçümden önce kilitlendi; testte `CONTRACT` olarak da sabittir)

- `holdoutPerFamily` = 5; `minimumSamples` = 10; `repeats` = 3.
- `minEffect`: `{ process: 1, wallMs: 100, cpuMs: 100 }`.
- `wrongWriteTolerance` = 0 → tek yanlış yazma `REJECT`.
- `perTaskProcessGain`: aynı-yöntem holdout'un her görevinde `learnedProcesses < baselineProcesses`.
- `powerMet(m)`: her boyut için `holdoutSize >= requiredSample(m)` (§5). Process boyutu
  (birincil) yetersizse güç kapısı `INSUFFICIENT`.
- `wallGainStable`: R tekrarda `amortizedWallGainMs` verdict'i **aynı** olmalı (kararlılık).
- `cpuMeasured`: tüm tekrarlarda CPU kaydı mevcut olmalı; biri yoksa `NOT_MEASURED`.
- `cpuAmortizedGainMs = baselineCpuMs − learnedCpuMs − trainingCpuMs` (ikincil; raporlanır,
  ayrı verdict).
- Süre `process.hrtime.bigint()` ile ölçülür; CPU çocuk-process probe'u ile (§6).

## 8. Karar kuralları (sonuç görülmeden, öncelik sırası)

1. Leakage, kollar arası bütçe farkı, görev hash eşitsizliği, `NaN/Infinity`, learned kolda
   yanlış yazma, farklı-aile reddinin kaynağı değiştirmesi, yinelemeler arası process sayısı
   oynaması → **`REJECT`**.
2. Process boyutunda `powerMet=false`, holdout boş veya `holdoutSize < minimumSamples` →
   **`INSUFFICIENT`**.
3. Duvar-saati verdict'i yinelemeler arası **kararsız** → **`INSUFFICIENT`**.
4. CPU kaydı eksik **ve** CPU iddiası kurulacaksa → **`INSUFFICIENT`** (CPU `NOT_MEASURED`).
5. Aksi halde **`MEASURED`**; etiket (yön ve kararlılık, **işaret**e göre — mutlak değere göre
   değil, çünkü platformlar arası büyüklük oynar):
   - process kazancı her görevde **ve** process `powerMet` **ve** CPU ölçülü **ve** duvar-saati
     tüm tekrarlarda pozitif (`GAIN`) → **`GAIN`**;
   - process kazancı her görevde **ve** process `powerMet` **ve** CPU ölçülü, ama duvar-saati
     tüm tekrarlarda pozitif **değil** → **`MEASURED_NO_GAIN`** (process kazancı raporlanır,
     duvar-saati kazancı kanıtlanmamış kalır);
   - process kazancı yok → **`MEASURED_NO_GAIN`**.

Verdict **yalnız işaret ve kararlılığa** bağlıdır; tek koşumun ms büyüklüğüne bağlanmaz, böylece
platformlar arası oynaklık verdict'i çevirmez. `assertsGain` yalnız `GAIN` durumunda `true`'dur;
varsayılan/opt-in durumu değişmez (ayrı PR + #4060 G3 kabulü gerekir).

## 9. Kill / durdurma kriterleri

- Learned kol holdout doğruluğunu baseline'ın altına düşürürse → `REJECT`.
- Learned kolda yanlış yazma (`wrongWrites > 0`) veya yinelemeler arası process sayısı
  oynaması → `REJECT`.
- Aynı tekrarda deterministik sonuçlar (outcome/process sayıları) değişirse → `INSUFFICIENT`.
- CPU probe'u bir tekrarda kayıt üretemezse → CPU `NOT_MEASURED`, `GAIN` iddiası yok.

## 10. Kabul komutları

```sh
node --test test/coder-learning-g3-power-cost.test.js
```

Rapor, eval testinin `t.diagnostic` JSON çıktısıdır.

## 11. Kapsam dışı (bilinçli)

- Process kazancının kendisinin yeniden kanıtlanması (o #4380'de ölçüldü; burada güç girdisi).
- #4380'in anti-vakaları ve restart kalıcılığı (o kohortta kanıtlandı; burada tekrarlanmaz).
- Cross-family transfer **yeteneği** (#4415 ayrı issue).
- Production wiring; yeni receipt/wire/release; `intelligenceGain` sınıfı genel iddia.
- #4380 kohortunun model/fixture'larının yeniden kullanımı (tüketilmiş sayılır).
