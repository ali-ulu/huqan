# Coder öğrenme kazanımı — G3 break-even ufku ve önceki-beceri korunumu ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Külliyat (§4), bölme (§5), metrikler (§6),
eşikler (§7) ve karar kuralları (§8) bu commit ile donduruldu. Ölçüm bu commit'ten **sonra**,
aynı PR içinde koşulur; sonuç ayrı bir belgede raporlanır
(`coder-learning-g3-breakeven-retention-result-20261101.md`).

**Base:** `9d9d5d49` (origin/main).
**Issue:** [#4505](https://github.com/ali-ulu/huqan/issues/4505).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki:** #4449 → PR #4462 (N=70 mühürlü kohort, doğruluk/process `GAIN`); #4470 → PR #4472
(G3 kapanış boyutları, eğitim dahil amortize maliyet `MEASURED_NO_GAIN`, eski-beceri
`INSUFFICIENT`); #4465 → PR #4477/#4478 (M3 H1 bağımsız aile korpusu `MEASURED_NO_GAIN`);
#4428 → `NOT_MEASURED` (gerçek görev zinciri synthesis kontratı taşımıyor).

## 0. Amaç ve sınır

#4505, tamamlanan G3/M3 ölçümlerinin bıraktığı iki boşluğu kapatacak **yeni, bağımsız,
ön-kayıtlı** bir ölçüm ister:

1. **Amortizasyon (break-even) ufku.** #4470 tek bir kohort büyüklüğünde (10 holdout) eğitim
   dahil amortize maliyeti ölçtü ve negatif buldu; ama "eğitim/kalibrasyon/journal yükü hangi
   tekrarlı-kullanım ufkunda geri ödenir" sorusunu **doğrudan** yanıtlamadı. Bu belge
   per-kullanım tasarrufun eğitim maliyetini ilk kez karşıladığı **ufku (n\*)** ölçer.
2. **Önceki-beceri korunumu (retention).** #4470'in eski-beceri boyutu, öğrenilen belleğin
   **aile başına tek aday** tutması nedeniyle "daha önce öğrenilmiş farklı bir becerinin
   korunması"nı değil, taze bir same-family görevinin dağıtımını ölçtüğünü açıkça yazdı
   (`priorSkill.scope = 'fresh-same-family-transfer'`, `INSUFFICIENT`). Bu belge, **iki farklı
   aile** becerisini arka arkaya öğrenip **önce öğrenileni sonra öğrenmeden sonra** yeniden
   dağıtarak gerçek retention'ı ölçer.

Sınırlar:
- Bu bir **ölçüm protokolüdür**. Runtime kodu, wiring, eşik veya varsayılan değişmez;
  `lib/` altında hiçbir dosya değişmez.
- **Kapsam kararı (en küçük tam değişiklik):** #4462 (N=70 doğruluk/process) ve #4470
  (güç/CPU/RSS/restart/kayma) zaten commit'e bağlıdır ve burada **tekrarlanmaz**; bu ölçüm
  yalnız o ikisinin bıraktığı iki boyutu ekler.
- Kaynak yine **gerçek** `coder --synthesize` mühürlü günlük kaydıdır (§2). Holdout
  **görevleri** fixture'dır (#4449/#4465/#4470 ile aynı sınırlama, §9); kaynak değildir.
  **Gerçek-repo synthesis görevi üreten bir mekanizma repoda yoktur** (bkz. §9), bu yüzden
  "non-fixture real repository tasks" kabul kriteri bu protokolle karşılanamaz ve raporda
  açıkça sınır olarak yazılır.
- Sonuç ne çıkarsa `GAIN` / `MEASURED_NO_GAIN` / `INSUFFICIENT` / `NOT_MEASURED` / `REJECT`
  olarak olduğu gibi raporlanır. Yönlü bir sonuç vaat edilmez.

## 1. Hipotezler

- **H0 (break-even):** per-kullanım tasarruf (baseline − learned, görev başına) medyanı
  ≤ 0'dır; eğitim maliyeti hiçbir sonlu ufukta geri ödenmez → `n*` yoktur (`NOT_REACHED`).
- **H0 (retention):** önce öğrenilen beceri (aile A), sonra öğrenilen farklı-aile becerisi
  (aile B) sonrasında taze A görevlerinde **kaybolur** (dağıtılmaz) ya da doğruluk/process
  bakımından geriler.
- **H1 (yönlü):** per-kullanım tasarruf medyanı > 0'dır ve eğitim maliyeti sonlu bir `n*`
  ufkunda geri ödenir; ayrıca önce öğrenilen beceri sonraki farklı-aile öğrenmesinden sonra
  taze A görevlerinde **korunur** ve doğruluk non-inferior kalır (`≥ -0.05` Newcombe alt
  sınırı), process kötüleşmez.

## 2. Gerçek görev kaynağı (kanıtlanmış zincir — #4449/#4470 ile aynı)

```
coder <task.json> --synthesize --authorize --journal <db> --run-id <id>   lib/cli-coder.js
  -> experience_journal: hash-zincirli satırlar                           lib/experience/journal.js
  -> readSealedRun(journal, '<id>:c1', workspaceId)                       lib/experience/learning-intake.js
     => { ok:true, manifest.closed:true,
          learningEligibility:'positive_procedure', outcomeStatus:'verified' }
```

- Kaynak yalnız `manifest.closed === true` mühürlü koşumlardır; açık veya düzenlenmiş kayıt
  fail-closed reddedilir (`run_not_sealed` / `integrity_mismatch`).
- Her katkıda bulunan koşum (eğitim, retention, integrity probe) raporun
  `sourceRevision.sealedRuns` alanında `sourceHash` + `manifest.closed` ile bağlanır.

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Aile başına taze çalışma kökü; görevler `--synthesize`, bellek yok. |
| Learned kol | Aynı görevler; aile A eğitimi **önce** (`rememberFile`), aile B eğitimi **sonra**, ardından `--adapt-memory`. |
| Eşit bütçe | Her iki kol `BUDGET = 8` process limiti; aynı görev hash'leri, aynı kaynak, aynı test komutları. |

## 4. Külliyat (ölçümden önce kilitlendi)

- **Birim:** mühürlü bir synthesis koşumundan türetilen bir görev.
- **Aileler (2, bağımsız):** `arithmetic-expression` (buggy `x => x + 1`, hedef `x % 2`) ve
  `string-expression` (buggy `p.toUpperCase()`, hedef `p.trim().toLowerCase()`).
- **Eğitim görevi:** aile başına 1 (kohortta sayılmaz). Aile A önce, aile B sonra öğrenilir.
- **Retention kohortu:** aile başına **30**, toplam **N = 60** (taze same-family görevler;
  §7 marj gerekçesi). Aile A görevleri önce öğrenilen becerinin korunumunu; aile B görevleri
  sonra öğrenilen becerinin çalışmasını ölçer. İki aday aynı anda havuzda bulunur.
- **Anti-vaka:** `manifest.closed !== true` veya `learningEligibility` pozitif prosedür değil
  → görev kohorttan düşer (fail-closed).

## 5. Bölme ve sızıntı

- Bölmeler `train / retention` düzeyinde ayrılır; eğitim görev kimlikleri retention
  kohortunda **görünmez** (`assert` ile kontrol edilir, sızıntı → `REJECT`).
- Retention görevleri hiçbir eğitim adımında kullanılmaz. Aile adları ve görev kimlikleri
  #4380/#4416/#4449/#4470 kohortlarından **bağımsızdır** (yeniden kullanılmaz).

## 6. Metrikler ve yön

- **Birincil (break-even):** per-kullanım tasarruf `s = baseline_cost − learned_cost`
  (görev başına, eşli); ufuk `n* = ceil(T / median(s))` — `T` eğitim (iki beceri) maliyeti.
  Metrik başına (duvar-saati, CPU) ayrı. `s ≤ 0` ise `n*` yoktur (`NOT_REACHED`).
  Dağılım (görev başına tasarruf listesi) ve %95 bootstrap güven aralığı raporlanır.
- **İkincil (retention):** retention kohortunda doğruluk eşitliği (tam Newcombe tek-yönlü
  %95 alt sınırı) ve process non-inferiority (learned ≤ baseline). Aile A (önce öğrenilen)
  için bu, **önceki-beceri korunumudur**; aile B için sonra öğrenilen becerinin çalışmasıdır.
- **Maliyet:** duvar-saati, CPU ve **tepe RSS** ayrı raporlanır. Amortize toplam **eğitim
  maliyetini içerir**. Ölçülemeyen boyut `NOT_MEASURED` kalır.
- **Bütünlük:** firewall bypass ve approval bypass ölçülür; sıfırdan farklıysa `REJECT`.
- **Kaynak bağı:** her katkıda bulunan koşum mühürlü kaynağına bağlanır.

## 7. Ön-kayıtlı eşikler (ölçümden önce kilitlendi)

- **MIN_EFFECT:** process `1.0`, wallMs `100`, cpuMs `100`, rssKb `2048` (#4470 ile aynı).
- **Eğitim maliyeti `T`:** iki beceri eğitimi R = 3 tekrar ile ölçülür (dağılım + medyan).
- **Retention örneklemi:** N = 60 (aile başına 30). `-0.05` Newcombe marjı sıfır-varyanslı
  bir sonuçta ilk kez **N = 59**'da kanıtlanabilir (#4449/#4422); N = 60 ≥ 59 → marj
  kanıtlanabilir. `N < 59` olsaydı retention boyutu `INSUFFICIENT` olurdu.
- **Break-even ufku:** `n*` sonlu ve `≤ breakEvenHorizonMax = 32` ise "ulaşılabilir"
  sayılır (32 = aday havuzu üst sınırı; ufuk bu sınırı aşarsa pratikte ulaşılamaz).
- **Amortize net kazanç:** `net = N * median(s) − T`; kazanç kapısı `net > 0`.
- **Yanlış yazma toleransı:** 0.

## 8. Karar kuralları (öncelik sırası) ve fail-closed

1. Mühürlü gerçek koşum yok → `NOT_MEASURED`.
2. Eşleşmeyen kollar, bölme sızıntısı, geçersiz kayıt → `REJECT`.
3. Sıfırdan farklı firewall/approval bypass veya yanlış yazma → `REJECT`.
4. Aksi halde `MEASURED`; etiket kilitli kurallardan:
   - retention non-inferior **ve** marj kanıtlanabilir **ve** break-even `n*` sonlu **ve**
     `≤ breakEvenHorizonMax` **ve** `net > 0` → **GAIN**;
   - per-kullanım tasarruf medyanı ≤ 0 (kararlı) veya `net ≤ 0` → **MEASURED_NO_GAIN**;
   - marj kanıtlanamıyor veya bir maliyet boyutu ölçülemedi → **INSUFFICIENT**.

**`assertsGain` her durumda `false`** (§9): varsayılan/terfi ayrı PR ve G3 kabulü sonrasıdır.

## 9. İddia sınırı ve bağlama

- Bu protokol G3'ün bıraktığı break-even ufku ve önceki-beceri korunumu boyutlarını gerçek
  mühürlü kaynakta ölçer; #4462 ve #4470 kanıtlarını tekrarlamaz.
- Kaynak gerçek ve mühürlüdür; **retention görevleri** `test/helpers/coder-g3-cohort-fixtures.js`
  fixture'larıdır. Ölçüm bu fixture'lar üzerinde gerçek CLI ve gerçek günlük deposu ile koşar.
- **Gerçek-repo sınırı (dürüst):** Öğrenme mekanizması yalnız bağımsız `test` + `synthesis`
  kontratlı görevlerde çalışır (`--synthesize` `Synthesis requires independent test.command`
  ile fail-closed düşer, #4428). Repoda gerçek-repo synthesis görevi üreten bir yol yoktur;
  bu yüzden #4505'in "non-fixture real repository tasks" kabul kriteri **bu mekanizmayla
  karşılanamaz**. Bu sınır sonuç belgesinde açıkça yazılır; sahte bir gerçek-görev iddiası
  kurulmaz.
- `assertsGain = false`; bu belge bir varsayılan/terfi iddiası kurmaz.
- Sonuç belgesi: `docs/task-packs/coder-learning-g3-breakeven-retention-result-20261101.md`.
- Eval: `test/g3-breakeven-retention.test.js`.
