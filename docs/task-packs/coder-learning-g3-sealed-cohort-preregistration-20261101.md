# Coder öğrenme kazanımı — G3 genişletilmiş mühürlü kohort ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Külliyat (§4), bölme (§5), metrikler (§6),
eşikler (§7) ve karar kuralları (§8) bu commit ile donduruldu. Ölçüm bu commit'ten **sonra**,
aynı PR içinde koşulur; sonuç ayrı bir belgede raporlanır
(`coder-learning-g3-sealed-cohort-result-20261101.md`).

**Base:** `411dcba6` (origin/main).
**Issue:** [#4449](https://github.com/ali-ulu/huqan/issues/4449).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki:** `docs/task-packs/g3-sealed-run-learning-preregistration-20261030.md` (#4432) ve
`g3-sealed-run-learning-result-20261030.md` (#4432 sonucu: `MEASURED_NO_GAIN`). Bu belge
**aynı kaynağı ve aynı protokolü** kullanır; tek fark kohort boyutudur. Önceki kohort
**tüketilmedi** (N=10 bir güç tabanıdır, bir holdout havuzu değil); yine de bu belge kendi
külliyatını yeniden dondurur, önceki belgenin külliyatına atıf yapmaz.

## 0. Amaç ve sınır

#4449 şunu ister: gerçek **mühürlü** Coder koşumlarından öğrenme kazancı, ön-kayıtlı
non-inferiority marjını **karşılayacak kadar büyük** bir kohortta ölçülmüş müdür?

#4432 sonucu, ölçümün geçerli olduğunu ama N=10'da sıfır-varyans Newcombe alt sınırının
(−0.2589) kilitli −0.05 marjını **yapısal olarak** karşılayamadığını gösterdi. Bu belge
N'yi, marjın ilk kez karşılandığı en küçük holdout sayısına çıkarır ve ölçümü tekrarlar.

Sınırlar:
- Bu bir **ölçüm protokolüdür**, ölçüm değil. Runtime kodu, wiring, eşik veya varsayılan
  değişmez; `lib/` altında hiçbir dosya değişmez.
- Sentetik fixture ile doldurulmaz: kaynak yine **gerçek** `coder --synthesize` mühürlü
  günlük kaydıdır (§2). Holdout **görevleri** fixture'dır (önceki ölçümle aynı sınırlama,
  §9); kaynak değildir.
- Sonuç ne çıkarsa `GAIN` / `MEASURED_NO_GAIN` / `INSUFFICIENT` / `REJECT` olarak olduğu
  gibi raporlanır. Yönlü bir sonuç vaat edilmez.

## 1. Hipotezler

- **H0:** Genişletilmiş kohortta öğrenilmiş kol, (a) doğrulukta non-inferiority marjını
  karşılamaz **veya** (b) görev başına doğrulama process'ini düşürmez.
- **H1 (yönlü):** Learned kol, (a) her görevde yanlış yazma 0 iken doğruluğu baseline ile eşit
  tutar ve tek-yönlü %95 **tam (Newcombe)** alt sınırı ≥ −0.05 olur, (b) paired her görevde
  daha az doğrulama process'i kullanır.

Bu, #4432 H1'inin daha büyük kohorttaki tekrarıdır; amaç farklı bir mekanizma değil, aynı
mekanizmanın marjı kanıtlayan örneklemde ölçülmesidir.

## 2. Gerçek görev kaynağı (kanıtlanmış zincir — #4432 ile aynı)

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>   lib/cli-coder.js
  -> experience_journal: 7 hash-zincirli satır                            lib/experience/journal.js
  -> readSealedRun(journal, '<id>:c1', workspaceId)                       lib/experience/learning-intake.js
     => { ok:true, manifest.closed:true,
          learningEligibility:'positive_procedure', outcomeStatus:'verified' }
```

- Kaynak yalnız `manifest.closed === true` mühürlü koşumlardır; açık veya düzenlenmiş kayıt
  fail-closed reddedilir (`NOT_SEALED` / `INTEGRITY_MISMATCH`).
- Her holdout görevinin learned koşumu bu mühürlü kaydı üretir; ölçüm bunu **görev başına**
  doğrular (`sealedEligibility === 'positive_procedure'`).

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Aile başına taze çalışma kökü; görevler `--synthesize`, bellek yok. |
| Learned kol | Aynı görevler; aile eğitim görevi `--synthesize` + `rememberFile`, sonra `--adapt-memory`. |
| Eşit bütçe | Her iki kol `BUDGET = 8` process limiti; aynı görev hash'leri, aynı kaynak, aynı test komutları. |

## 4. Külliyat (ölçümden önce kilitlendi)

- **Birim:** mühürlü bir synthesis koşumundan türetilen bir görev.
- **Aileler (2, bağımsız):** `arithmetic-expression` (buggy `p => p + 1`, hedef `p % 2`) ve
  `string-expression` (buggy `p.toUpperCase()`, hedef `p.trim().toLowerCase()`).
- **Holdout sayısı:** aile başına **35**, toplam **N = 70** (§7'de gerekçe).
- **Eğitim görevi:** aile başına 1 (kohortta sayılmaz, bölme dışı).
- **Bağımsızlık:** görev adları ve parametreleri benzersizdir; aynı görev kimliği iki kez
  sayılmaz.
- **Anti-vaka:** `manifest.closed !== true` veya `learningEligibility` pozitif prosedür değil
  → görev kohorttan düşer (fail-closed).

## 5. Bölme ve sızıntı

- Bölmeler `train / holdout` düzeyinde ayrılır; eğitim görev kimlikleri holdout'ta
  **görünmez** (`assert` ile kontrol edilir, `LEAK` → `REJECT`).
- Holdout hiçbir eğitim/selection adımında kullanılmaz.
- Calibration bölmesi bu kohortta **yoktur**; §7 güç sonucu bu yüzden `NOT_DERIVED` raporlanır
  (aşağıda).

## 6. Metrikler ve yön

- **Birincil:** bağımsız gözlenmiş görev başarısı / yanlış yazma oranı.
- **İkincil:** görev başına doğrulama process sayısı (paired, baseline − learned).
- **Maliyet:** duvar-saati ve CPU **ayrı** raporlanır ve kazanç iddiası için **şart değildir**
  (#4380/#4416 dersi: process kazancı duvar-saati kazancı değildir). Ölçülemezse `NOT_MEASURED`.
- **Bütünlük:** firewall bypass ve approval bypass ölçülür; sıfırdan farklıysa `REJECT`.

## 7. Ön-kayıtlı eşikler (ölçümden önce kilitlendi)

**Kohort boyutu gerekçesi (N = 70).** §7'nin non-inferiority kuralı tek-yönlü %95 **tam**
alt sınırdır. Sıfır farkta (her iki kol da başarılı) Newcombe farkının alt sınırı N ile
daralır ve −0.05 marjını **ilk kez N = 59'da** karşılar:

| N | Newcombe alt (0 fark) | marj ≥ −0.05 |
|---|---|---|
| 10 | −0.2589 | hayır |
| 40 | −0.0722 | hayır |
| 58 | −0.0503 | hayır |
| **59** | **−0.0495** | **evet** |
| 60 | −0.0487 | evet |

N = 70, marjı karşılayan en küçük değerin (59) üstünde bir pay bırakır ve tam bölünebilir
iki aileye (35 + 35) oturur. N < 59 ile ölçüm **yapısal olarak** marjı karşılayamaz; o
durumda dürüst etiket `INSUFFICIENT`'tır, `MEASURED_NO_GAIN` değil.

- **Güç:** `n = ceil(((z_alpha + z_power) * sigma / MIN_EFFECT)^2)`, `alpha 0.05` / `power 0.8`
  (`z_alpha 1.96`, `z_power 0.84`), `MIN_EFFECT` ve `minimumSamples` M9 holdout ön-kaydıyla
  aynı yöntemle (`lib/cognitive-lab-m9-holdout.js::requiredSample`) hesaplanır.
- **sigma:** calibration bölmesi bu kohortta yok → §7 `power: NOT_DERIVED` (önceki ölçümle
  aynı; `minimumSamples` yalnız **taban** olarak raporlanır).
- **Non-inferiority:** başarı için tek-yönlü %95 **tam (Newcombe)** alt sınırı `≥ −0.05`
  olmalıdır. Nokta tahmini (0 fark) non-inferiority kanıtı **değildir**; sıfır varyansta
  normal yaklaşım yanlış `PASS` verir (#4422 dersi).
- **Cost:** process kazancı paired her görevde pozitif olmalı; duvar-saati/CPU ayrı raporlanır
  ve `INSUFFICIENT` olabilir (kazanç iddiası için şart değildir).
- **Yanlış yazma toleransı:** 0.

## 8. Karar kuralları (öncelik sırası) ve fail-closed

1. Mühürlü gerçek koşum yok veya N < `minimumSamples` → `NOT_MEASURED` / `INSUFFICIENT`.
2. Eşleşmeyen kollar, bölme sızıntısı, geçersiz kayıt → `REJECT`.
3. Sıfırdan farklı firewall/approval bypass veya yanlış yazma → `REJECT`.
4. Aksi halde `MEASURED`; etiket kilitli aralıktan:
   - `process lower > 0` **ve** başarı non-inferior (Newcombe ≥ −0.05) → **GAIN**;
   - başarı Newcombe alt sınırı < −0.05 → **MEASURED_NO_GAIN**;
   - aksi → **NOT_CLEARED**.

**`assertsGain` her durumda `false`** (§9): varsayılan/terfi ayrı PR ve G3 kabulü sonrasıdır.

## 9. İddia sınırı ve bağlama

- Bu protokol yalnız G3 corpus koşulunu genişletir; maliyet/dağılım/restart/eski-beceri
  ölçümleri ayrı ön-kayıt ve koşumlardır.
- Kaynak gerçek ve mühürlüdür; **holdout görevleri** `test/helpers/coder-g3-cohort-fixtures.js`
  fixture'larıdır. Ölçüm bu fixture'lar üzerinde gerçek CLI ve gerçek günlük deposu ile koşar.
- `assertsGain = false`; bu belge bir varsayılan/terfi iddiası kurmaz.
- Sonuç belgesi: `docs/task-packs/coder-learning-g3-sealed-cohort-result-20261101.md`.
- Eval: `test/g3-sealed-run-cohort-result.test.js`.
