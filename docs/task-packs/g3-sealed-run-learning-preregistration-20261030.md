# G3 öğrenme ölçümü — gerçek kaynak ön-kaydı (mühürlü synthesis koşum günlüğü)

**Status:** protokol ölçümden önce kilitlendi. Kaynak, kohort sınırları (§4), bölme (§5),
metrikler (§6), eşikler (§7) ve karar kuralları (§8) bu commit ile donduruldu.

**Base:** `d0cfee45` (origin/main).
**Issue:** [#4432](https://github.com/ali-ulu/huqan/issues/4432).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki:** #4424 (ön-kayıt) ve #4428 (sonuç: `NOT_MEASURED`). #4428, `produceTask`
kaynağının **öğrenme değil deterministik onarım** ürettiğini kanıtladı; bu belge öğrenme
mekanizmasını taşıyan **gerçek** kaynağı tanımlar.

## 0. Amaç ve sınır

`docs/cognitive-architecture-plan.md` §G3 corpus koşulu, ölçümün **sınırları ilan edilmiş
gerçek görevlerden** türetilmesini ister. #4428'de gerçek kaynak öğrenme kollarıyla
uyuşmadı. Bu belge, öğrenmenin **fiilen koşulduğu** gerçek kaynağı tanımlar.

Sınırlar:
- Bu belge bir **ölçüm protokolüdür**, ölçüm değil. Runtime kodu, wiring, eşik veya
  varsayılan değişmez; `lib/` altında hiçbir dosya değişmez.
- Yeterli mühürlü koşum yoksa sonuç `NOT_MEASURED`'dır. Sentetik fixture ile doldurulmaz (§8).

## 1. Hipotez

- **H0:** Mühürlü gerçek synthesis koşumlarından türetilen görevlerde öğrenilmiş kol,
  baseline'a göre doğrulukta eşitliği korumaz veya görev başına doğrulama process'ini düşürmez.
- **H1 (yönlü):** Learned kol, (a) her görevde yanlış yazma 0 iken doğruluğu baseline ile eşit
  tutar, (b) paired her görevde daha az doğrulama process'i kullanır.

Bu, #4380'in H1'inin gerçek kaynak üzerindeki tekrarıdır; amaç farklı sonuç değil, aynı
sonucun sentetik olmayan ve **öğrenmeyi taşıyan** kaynakta görülüp görülmediğidir.

## 2. Gerçek görev kaynağı (kanıtlanmış zincir)

Sentetik grammar yerine üretimde fiilen koşulmuş bir synthesis koşumunun mühürlü journal kaydı:

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>   lib/cli-coder.js
  -> experience_journal: 7 hash-zincirli satır                            lib/experience/journal.js
     run_started -> action_proposed -> policy_decided -> execution_started
       -> execution_finished -> verification -> run_closed
  -> readSealedRun(journal, '<id>:c1', workspaceId)                       lib/experience/learning-intake.js
     => { ok:true, events:7, manifest.closed:true,
          learningEligibility:'positive_procedure', outcomeStatus:'verified' }
  -> buildLearningProposal(...) => { ok:true, admission:'admitted', registered:false }
```

- Kaynak yalnız `manifest.closed === true` mühürlü koşumlardır; açık koşum `NOT_SEALED`
  ile reddedilir. Mühürlü kayıt değişmezdir (`lib/experience/learning-intake.js`).
- Kayıtlar **hash-zincirli**dir (`lib/experience/journal.js`); dışarıdan düzenlenmiş kayıt
  `INTEGRITY_MISMATCH` verir. Uydurulamaz, taklit edilemez.
- Öğrenme uygunluğu (`learningEligibility`) koşumun kendi manifest'inden gelir; bir kayıt
  pozitif prosedür değilse öneri üretilmez.

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Aile başına taze çalışma kökü; görevler `--synthesize` ile, bellek yok. |
| Learned kol | Aynı görevler; aile eğitim görevi `--synthesize` + `rememberFile`, sonra `--adapt-memory`. |
| Eşit bütçe | Her iki kol `BUDGET = 8` process limiti; aynı görev hash'leri, aynı kaynak, aynı test komutları. |

## 4. Külliyat (ölçümden önce kilitlendi)

- **Birim:** mühürlü bir synthesis koşumundan türetilen bir görev.
- **Aile:** koşum görevinin `synthesis.family` alanı (`arithmetic-expression`,
  `string-expression`, `conditional-expression`, `pipeline`, …); en az iki bağımsız aile zorunlu.
- **Bağımsızlık:** aynı `sourceHash` tekrarı bağımsız örnek sayılmaz.
- **Anti-vaka:** `manifest.closed !== true` (açık koşum) veya `learningEligibility` pozitif
  prosedür değil → hiç görev üretilmez (fail-closed).
- **Kohort boyutu:** §7 güç hesabı; küçük kohort yalnız pilot/karakterizasyondur.
- **Gerçek kayıt yoksa:** ölçüm `NOT_MEASURED`; sentetik fixture ile doldurulmaz.

## 5. Bölme ve sızıntı

- Bölmeler `train/calibration/holdout` **koşum grubu** düzeyinde ayrılır; aynı `sourceHash`'in
  türevleri tek grupta kalır, bölme sınırını geçemez.
- `auditSplits` fail-closed: bir görev kimliği iki bölmede görünürse `LEAK` → `REJECT`.
- Holdout hiçbir eğitim/selection adımında kullanılmaz.

## 6. Metrikler ve yön

- **Birincil:** bağımsız gözlenmiş görev başarısı / yanlış yazma oranı.
- **İkincil:** görev başına doğrulama process sayısı (paired, baseline − learned; pozitif
  learned lehine).
- **Maliyet:** model/araç çağrısı, süre ve bellek **ayrı** raporlanır. Process sayısı tek
  başına duvar-saati kazancı sayılmaz (#4380 dersi).
- **Bütünlük:** firewall bypass ve approval bypass ölçülür; sıfırdan farklıysa `REJECT`.

## 7. Ön-kayıtlı eşikler (ölçümden önce kilitlendi)

- **Güç:** `n = ceil(((z_alpha + z_power) * sigma / MIN_EFFECT)^2)`, `alpha 0.05` / `power 0.8`
  (`z_alpha 1.96`, `z_power 0.84`), `MIN_EFFECT` ve `minimumSamples` M9 holdout ön-kaydıyla
  aynı yöntemle (`lib/cognitive-lab-m9-holdout.js::requiredSample`) hesaplanır.
- **sigma:** calibration bölmesinin paired process deltalarından, holdout açılmadan ölçülür.
- **Non-inferiority:** başarı için tek-yönlü %95 **tam (Clopper–Pearson)** alt sınırı
  `≥ -0.05` olmalıdır. Nokta tahmini (0/0 fark) non-inferiority kanıtı değildir; sıfır
  varyansta normal yaklaşım yanlış `PASS` verir (#4422 dersi).
- **Cost:** process kazancı paired her görevde pozitif olmalı; duvar-saati ayrı raporlanır ve
  `INSUFFICIENT` olabilir (kazanç iddiası için şart değildir).

## 8. Karar kuralları (öncelik sırası) ve fail-closed

1. Mühürlü gerçek koşum yok / sayı `minimumSamples` altında → `NOT_MEASURED` / `INSUFFICIENT`.
2. Eşleşmeyen kollar, bölme sızıntısı, geçersiz kayıt → `REJECT`.
3. Sıfırdan farklı firewall/approval bypass veya yanlış yazma → `REJECT`.
4. Aksi halde `MEASURED`; etiket kilitli aralıktan:
   - `lower > 0` (process) ve başarı non-inferior → **GAIN**;
   - başarı `-0.05` altı veya harm → **MEASURED_NO_GAIN**;
   - aksi → **NOT_CLEARED**.

**`assertsGain` her durumda `false`** (§9): varsayılan/terfi ayrı PR ve G3 kabulü sonrasıdır.

## 9. İddia sınırı ve bağlama

- Bu protokol yalnız G3 corpus koşulunu karşılar; maliyet/dağılım/restart/eski-beceri
  ölçümleri ayrı ön-kayıt ve koşumlardır.
- Sentetik kontrol seti (#4380/#4416/#4415) **ayrıca** raporlanmıştır; bu belge onları
  kullanmaz.
- Deterministik onarım kaynağı (başarısızlık kaydı → `produceTask`) bu belgenin kapsamı
  dışındadır; o soru ayrı ön-kayıttır (#4433).
