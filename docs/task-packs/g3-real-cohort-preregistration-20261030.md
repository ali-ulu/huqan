# G3 birleşik kabul — gerçek (sentetik olmayan) görev kohortu ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Kaynak, kohort sınırları (§4), bölme (§5),
metrikler (§6), eşikler (§7) ve karar kuralları (§8) bu commit ile donduruldu.

**Base:** `59874107` (origin/main).
**Issue:** [#4423](https://github.com/ali-ulu/huqan/issues/4423).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki G3 ölçümleri:** `coder-learning-g3-cohort-preregistration-20261030.md` (#4380),
`coder-learning-g3-power-cost-preregistration-20261030.md` (#4416),
`coder-learning-g3-cross-family-preregistration-20261030.md` (#4415). Üçü de **sentetik
fixture grammar** kullandı; bu belge o kohortları kullanmaz.

## 0. Amaç ve sınır

`docs/cognitive-architecture-plan.md` §G3 corpus koşulu iki şey ister: (a) ölçüm **sınırları
ilan edilmiş gerçek görevlerden** türetilen bağımsız örnekler üzerinde olmalı; (b) sentetik
kontrol seti **ayrıca** raporlanmalı. Önceki ölçümler yalnız (b)'yi sağladı. Bu belge (a)'yı
tanımlar.

Sınırlar:
- Bu belge bir **ölçüm protokolüdür**, ölçüm değil. Runtime kodu, wiring, eşik veya
  varsayılan değişmez; `lib/` altında hiçbir dosya değişmez.
- Gerçek kohort henüz yoksa sonuç `NOT_MEASURED`'dır. Uydurulmuş kayıtla ölçüm koşulmaz;
  kayıt yokluğu fail-closed durur (§8).

## 1. Hipotez

- **H0:** Doğrulanmış gerçek başarısızlık kayıtlarından türetilen görevlerde öğrenilmiş kol,
  baseline'a göre doğrulukta eşitliği korumaz veya görev başına doğrulama process'ini
  düşürmez.
- **H1 (yönlü):** Learned kol, (a) her görevde yanlış yazma 0 iken doğruluğu baseline ile eşit
  tutar, (b) paired her görevde daha az doğrulama process'i kullanır.

Bu, #4380'in H1'inin gerçek kaynak üzerindeki **tekrarıdır**; amaç farklı bir sonuç değil,
aynı sonucun sentetik olmayan kaynakta da görülüp görülmediğidir.

## 2. Gerçek görev kaynağı (kanıtlanmış zincir)

Sentetik grammar yerine üretim yolundaki doğrulanmış başarısızlık kaydı:

```
ErrorPrevention.recordFailure()          lib/error-prevention/engine.js
  -> verified failure_record             lib/error-prevention/failure-record.js
  -> produceTask()                        lib/task-producer.js
  -> `coder propose <failure.json>`       lib/cli-coder-propose.js
  -> `coder <task.json>` (gerçek gate)    lib/cli-coder.js
```

- Kaynak yalnız `verificationStatus === 'verified'` kayıtlardır; `task-producer` doğrulanmamış
  kaydı `NEEDS_HUMAN_DECISION` ile reddeder, uydurmaz.
- `lib/self-healer/fix-producer.js` bu köprüyü bulgu yoluna bağlar (`applied:false`, görev
  yine `code-change-gate`'ten geçer).
- Köprü yerelde mock'suz doğrulandı: doğrulanmış kayıt `TASK_PRODUCED` verdi; üretilen görev
  gerçek `coder` koşumunda `SOURCE_CHANGE_REQUIRES_REVIEW` ile `review` kararı aldı.

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Aile başına taze çalışma kökü; görevler `--synthesize` ile. |
| Learned kol | Aynı görevler; aile eğitim görevi `--synthesize` + `rememberFile`, sonra `--adapt-memory`. |
| Eşit bütçe | Her iki kol `BUDGET = 8` process limiti; aynı görev hash'leri, aynı kaynak, aynı test komutları. |

## 4. Külliyat (ölçümden önce kilitlendi)

- **Birim:** bir doğrulanmış başarısızlık kaydından türetilen bir görev.
- **Aile:** kaydın `action.path` uzantısı ve `operation` tipi; en az iki bağımsız aile
  (ör. `replace_text` ve `rename_identifier`) zorunludur.
- **Bağımsızlık:** aynı kaydın tekrarı bağımsız örnek sayılmaz; `failureFingerprint` tekildir.
- **Anti-vaka:** kaydın işaret ettiği dosya gerçek ağacında bulunmayan veya `operation`
  desteklenmeyen kayıt → `NEEDS_HUMAN_DECISION`, hiç görev üretilmez (fail-closed).
- **Kohort boyutu:** §7 güç hesabı; küçük kohort yalnız pilot/karakterizasyondur.
- **Gerçek kayıt yoksa:** ölçüm `NOT_MEASURED`; sentetik fixture ile doldurulmaz.

## 5. Bölme ve sızıntı

- Bölmeler `train/calibration/holdout` **kayıt grubu** düzeyinde ayrılır; aynı kaydın
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

1. Gerçek kohort yok / kayıt sayısı `minimumSamples` altında → `NOT_MEASURED` / `INSUFFICIENT`.
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
  geçersiz kılmaz.
- Bu PR yalnız bu belgeyi ve pinleme testini ekler; `lib/` değişmez, `assertsGain` `false`,
  `intelligenceGain` `NOT_MEASURED`'dır.
