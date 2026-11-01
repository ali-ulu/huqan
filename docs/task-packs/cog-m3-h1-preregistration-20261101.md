# COG-M3 — bağımsız aile korpusu ve H1 ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Külliyat (§4), bölme (§5), metrikler (§6),
eşikler (§7) ve karar kuralları (§8) bu commit ile donduruldu. Ölçüm bu commit'ten **sonra**
koşulur; sonuç ayrı bir belgede raporlanır (`cog-m3-h1-result-20261101.md`).

**Base:** `ef9e2d65` (origin/main).
**Issue:** [#4465](https://github.com/ali-ulu/huqan/issues/4465).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (COG — bilişsel mimari programı).
**Önceki:** `cog-m3-replay-preregistration-20261027.md` (#4069) protokolü tanımladı ve
"bağımsız corpus/split manifesti ve hash'leri bu teslimde üretilmedi" diye açık bıraktı.
`cog-m3-family-evaluation-contract.md` (#4469) aile düzeyinde paired adapter'ı (M3 evaluator)
hazırladı. Bu belge, #4069'un açık bıraktığı **kilitli bağımsız külliyatı** üretir ve
adapter'ı gerçek native kanıtla sürer.

## 0. Amaç ve sınır

#4069 §3 kuralını ölçer: **örnekleme birimi farklı ID değil, bağımsız kaynak/artefakt
ailesidir.** Aynı kaynağın tekrar koşusu, ortak ancestor, aynı üretilmiş artefakt tek
gruptur. Bu külliyat, her aile için **ayrı** bir mühürlü Coder kaynak günlüğü kurar; aileler
bir kaynak artefaktı paylaşmaz.

Sınırlar:
- Bu bir **ölçüm protokolüdür**, ölçüm değil. `lib/` altında hiçbir dosya değişmez; yalnız
  ön-kayıt, külliyat kurucusu, ölçüm testi ve sonuç belgesi eklenir.
- Külliyat gerçek `coder` koşumlarından türetilir; sentetik episode ile doldurulmaz. Holdout
  ve transfer **görevleri** fixture'dır (hedef içerik önceden kilitlenir); kaynak değildir.
- Sonuç ne çıkarsa `GAIN` / `MEASURED_NO_GAIN` / `INSUFFICIENT` / `REJECT` olarak olduğu gibi
  raporlanır. Yönlü bir sonuç vaat edilmez.

## 1. Hipotezler

- **H0:** Priority (surprise-ağırlıklı) replay kolu, recent-K koluna göre bağımsız aile
  holdout görevlerinde **daha yüksek** doğru-sonuç oranı üretmez; yanlış yazma 0 iken
  doğruluk farkı anlamlı etkiyi (0) aşmaz.
- **H1 (yönlü):** Priority kolun holdout aile-ortalama doğruluğu, recent-K koluna göre
  anlamlı etkinin üzerindedir; her iki kol da yanlış yazma 0 üretir.

Tek değişken: episode seçimi (priority vs recent-K). Kaynak, dependency evreni, bütçe (K=32),
görev hash'leri ve oracle sabittir.

## 2. Gerçek görev kaynağı (kanıtlanmış zincir)

```
coder <task> --synthesize / runFixLoop                              lib/cli-coder.js · lib/coder/fix-loop.js
  -> experience_journal: hash-zincirli satırlar                      lib/experience/journal.js
     run_started -> action_proposed -> policy_decided -> routing_decided
       -> execution_started -> execution_finished -> verification -> run_closed
  -> readSealedRun(journal, '<id>:c1', workspaceId)                  lib/experience/learning-intake.js
     => { ok:true, manifest.closed:true, learningEligibility, outcomeStatus }
```

- Pozitif kaynak: `applyDerivation` (doğrulama geçer) → `learningEligibility: positive_procedure`.
- Negatif kaynak: `runFixLoop` (test asla geçmez → yazma geri alınır, koşum failed kapanır) →
  `learningEligibility: negative_example`. Reward sinyali bunu -1 olarak skorlar.
- Kaynak yalnız `manifest.closed === true` mühürlü koşumlardır; açık/düzenlenmiş kayıt
  fail-closed reddedilir.

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| A1 (recent-K) | `groupForRecentCandidates`: en yeni K episode. |
| A2 (priority) | `groupForCandidates`: surprise-ağırlıklı öncelik, en yüksek K episode. |
| Eşit bütçe | K = 32 (adapter sabiti); aynı kaynak, aynı dependency evreni, aynı oracle. |

Her kol, seçtiği destek kümesinden derlenen prosedürü **gerçek** `runFixLoop` ile hedef
göreve uygular. Kol başına **ayrı** journal kopyası kullanılır: iki kol aynı capabilityId'yi
farklı prosedür hash'ine bağlarsa `replayCoderTrust` bunu `capability_binding_changed` ile
reddeder; ayrı kopya bunu önler.

## 4. Külliyat (ölçümden önce kilitlendi)

- **24 bağımsız holdout ailesi** ve **8 transfer ailesi** (ilk 8 aile ayrıca transfer görevi taşır).
- Aile başına kaynak günlüğü: **6 negatif (eski)** + **30 pozitif (yeni)** = 36 mühürlü koşum.
  - Negatifler eskidir → recent-K onları dışarıda bırakır; priority yüksek magnitude'dan
    dolayı içeri alır → kollar **ayrışır** (non-inert).
  - Adapter `selection_inert` ile kolları hiç ayrışmayan külliyatı reddeder; bu yüzden ölçülebilir
    bir külliyat ayrışmak **zorundadır**. 36 > K (32) bunu sağlar.
  - Tutarlılık: 30/36 ≈ 0.833 ≥ 0.8 (`CONSISTENCY_MIN`), dolayısıyla aday üretilir.
- Aile başına capability (`h1-cap-<i>`), hedef dosya (`value-<i>.js`) ve ayrık `find`/`replace`
  (`alpha<i>` → `beta<i>`) farklıdır; `replace`, `find`'i içermez (compile postcondition).

## 5. Bölme ve sızıntı denetimi

Üç grup **ayrıktır**:
- **source:** ailenin kendi mühürlü koşumları,
- **qualification:** replay request'inin held-out girdileri,
- **evaluation:** holdout/transfer görevi + **ayrı oracle** satırı.

Adapter iki kapıyı fail-closed uygular:
- `split_overlap` — bir aile etiketi iki bölmede görünemez,
- `qualification_or_source_overlap` — hiçbir oracle hedef digest'i source/qualification
  digest kümesinde olamaz.

Ölçüm testi bu iki özelliği ayrıca assert eder (§5, sızıntı denetimi).

## 6. Metrikler

- **Birincil:** holdout aile-ortalama doğru-sonuç oranı farkı (A2 − A1); aile düzeyinde
  paired bootstrap (2000 resample, %95, B4 sözleşmesi).
- **İkincil:** transfer aile-ortalama farkı; yanlış yazma sayısı; güven ihlali sayısı.
- Native doğruluk, her kolun mühürlü koşumundan **bağımsız oracle** ile yeniden türetilir
  (`nativeResult`): `applied_tested` + oracle eşleşmesi = doğru; oracle dışı yazma = yanlış yazma.

## 7. Eşikler

- `meaningfulEffect = 0`; `minimumSamples = 24`; `minimumTransfer = 8`; `wrongWriteTolerance = 0`
  (B4 sözleşmesi, #4469 ile aynı).
- `clearsEffect = primary.interval.lower > 0`.

## 8. Karar kuralları

Adapter `status` alanı (gerçek sözlük, `lib/cognitive-lab-m3-evaluator.js` /
`lib/cognitive-lab-m3-experiment.js`):

- Güven ihlali (herhangi bir kolda yanlış yazma veya ihlal) → **`REJECT`** (`trust_violation`).
- Holdout < 24 veya transfer < 8 → **`INSUFFICIENT`** (`sample_below_minimum`).
- Kollar hiç ayrışmıyor → **`INSUFFICIENT`** (`selection_inert`).
- Native kanıt eksik/doğrulanamaz → **`INSUFFICIENT`** (`native_evidence_unavailable`).
- Ölçüm tamamlanır → **`MEASURED`** (`family_paired_diagnostic`), ayrıca `clearsEffect`.

**H1 verdict** (bu belgenin ölçümden türettiği etiket; adapter'da böyle bir `status`
alanı **yoktur**, karıştırılmamalıdır):

- `status === 'MEASURED'` ve `clearsEffect === true` → **`GAIN`**.
- `status === 'MEASURED'` ve `clearsEffect === false` → **`MEASURED_NO_GAIN`**.
- `status === 'REJECT'` → **`REJECT`**; `status === 'INSUFFICIENT'` → **`INSUFFICIENT`**.

`assertsGain` her dalda **`false`** (bu bölümün kuralı): ölçüm rapor eder, varsayılan terfi ettirmez.

## 9. Sınırlar

- Holdout/transfer **görevleri** fixture'dır (hedef içerik ön-kilitli); kaynak gerçektir.
  Bu, önceki G3 ölçümleriyle aynı sınırdır.
- Güç analizi (`sigma` kalibrasyon bölmesinden) bu külliyatta **türetilmez**; `minimumSamples`
  bir tabandır, güç iddiası değildir.
- Ölçüm bir CI testidir; 32 aile gerçek koşumla ~25 s yerel (Windows'ta daha uzun), bu yüzden
  `HEAVY_FILES` kapsamındadır.
