# Coder öğrenme kazanımı — G3 bağımsız kohort ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Külliyat (§4), aile bölmesi, metrikler
(§6) ve eşikler (§7) bu commit ile donduruldu; ölçüm bu belge main'e girdikten sonra
koşulur ve sonuç ayrı bir sonuç belgesinde raporlanır.

**Base:** `14871fea` (origin/main), issue [#4380](https://github.com/ali-ulu/huqan/issues/4380).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki ölçüm:** `docs/task-packs/coder-learning-gain-accuracy-cost-preregistration-20261027.md`
(#4341). O holdout **tüketildi**; bu belge onu kullanmaz.
**Biçim referansı:** M9 holdout ön-kaydı (`cog-m9-holdout-preregistration-20261029.md`).

## 0. Amaç ve sınır

#4380 iddiasını ölçer: HUQAN Coder'ın öğrenme kazanımı **dar aynı-yöntem kohortunun
ötesine** taşınır mı — ikinci bir yöntem ailesinde de doğruluk korunur mu, **farklı
aileye aktarım** ne yapar, **dağılım kayması** ve **restart** altında kazanım kalır mı,
ve **eğitim dahil toplam maliyet** donmuş eşiği geçer mi?

Sınırlar:
- Bu, mevcut davranışın **ölçümüdür**; runtime kod değişikliği yoktur. Değişen dosyalar
  yalnızca bu ön-kayıt belgesi, eval testi ve sonuç belgesidir.
- Farklı aileye aktarım bu ölçümde **anti-vaka** olarak raporlanır: beklenen davranış
  aktarımın **reddi** (fail-closed) ve yanlış yazmanın olmamasıdır. Cross-family transfer
  yeteneği bu PR'ın kapsamı dışıdır (ayrı program; `docs/cognitive-architecture-plan.md`
  §"Bu programdan sonraya bırakılan kapasite").
- CPU maliyeti ölçülemezse `NOT_MEASURED` raporlanır (§7).

## 1. Hipotezler

- **H0:** Learned kol, ikinci aile dahil holdout görevlerinde baseline'a göre doğrulukta
  eşitliği korumaz veya eğitim dahil toplam maliyeti düşürmez.
- **H1 (yönlü):** Learned kol, (a) her iki ailenin holdout görevlerinde doğruluğu baseline
  ile eşit tutar (yanlış yazma 0), (b) paired her görevde daha az doğrulama process'i
  kullanır, (c) eğitim dahil **amortize toplam wall time** baseline holdout toplamının
  altında kalır.

## 2. Gerçeklik sınırı

Ölçüm `cli.js coder <task> --synthesize / --adapt-memory` gerçek giriş noktası üzerinden,
gerçek geçici Git depolarında koşar. Aileler: `arithmetic-expression` (parity) ve
`string-expression` (trim+lowercase). Bunlar iki **ayrı aynı-yöntem** kohortudur; genel
öğrenme başarısı iddiası çıkarılmaz.

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Aile başına taze çalışma kökü; holdout görevleri `--synthesize` ile. |
| Learned kol | Aynı fixture'lar; aile eğitim görevi `--synthesize` + `rememberFile` ile koşulur, sonra holdout görevleri `--adapt-memory` ile. |
| Eşit bütçe | Her iki kol `BUDGET = 8` process limiti (test içi `CONTRACT.budget`); aynı görev hash'leri, aynı kaynak içerik, aynı test komutları. |

## 4. Külliyat (ölçümden önce kilitlendi)

**Aile A — `arithmetic-expression`** (buggy `x => x + 1`, hedef `x % 2`):
- Eğitim: `arith-train` (`n`, örnek `[0,2,4]`, check `[5,8]`).
- Holdout (N = 3): `arith-one` (`base`, `[0,3,7]`, `[11,16]`), `arith-two` (`start`, `[0,9,13]`, `[21,26]`),
  `arith-three` (`origin`, `[0,15,19]`, `[27,34]`).
- Dağılım kayması (rapor amaçlı): `arith-shift` (`offset`, `[0,33,41]`, `[51,60]`).

**Aile B — `string-expression`** (buggy `fn(p) { return p.toUpperCase(); }`, hedef `p.trim().toLowerCase()`).
Sentez örnekleri **küçük harfli** (yalnız `trim()` gerekir, birden çok program eşleşir); gerçek test
girdileri **büyük harfli** (tam `trim().toLowerCase()` gerekir, doğru aday arama sırasında sonradır).
Bu, baseline'ın çok-aday denemesini sağlar; örnekler arama sırasını belirler, test sonucu belirlemez.
- Eğitim: `string-train` (`clean`/`value`; örnekler `' red '→red, ' blue '→blue, ''→''`; test `' RED '→red, ' BLUE '→blue`).
- Holdout (N = 3): `string-one` (`normalize`/`raw`; örnekler `' héllo '→héllo, ' world '→world, ''→''`; test `' HÉLLO '→héllo, ' WORLD '→world`),
  `string-two` (`tidy`/`item`; örnekler `' green '→green, ' yellow '→yellow, ''→''`; test `' GREEN '→green, ' YELLOW '→yellow`),
  `string-three` (`canonical`/`entry`; örnekler `' purple '→purple, ' orange '→orange, ''→''`; test `' PURPLE '→purple, ' ORANGE '→orange`).
- Dağılım kayması (rapor amaçlı): `string-shift` (`fold`/`label`; örnekler `' été '→été, ' çay '→çay, ''→''`; test `' ÉTÉ '→été, ' ÇAY '→çay`).

**Anti-vakalar:**
- **Farklı-aile aktarımı:** yalnız `arithmetic-expression` belleği olan bir kökte `string-expression`
  görevi `--adapt-memory` ile koşulur. Beklenen: `no_applicable_candidate` reddi, kaynak dosya
  değişmez, otomatik fallback yazımı yok.
- **Farklı-yöntem kontrolü:** aynı aile içinde, eğitim örnekleriyle ayrılamayan yeni bir hedef
  (`novel`: örnekler `[0,1,2]`→`2x+1`, test `[7,11]`→`[15,23]`) learned kökte `--adapt-memory` ile
  koşulur. Beklenen: bellek denemesi `memory` aşamasında rollback edilir, `search` aşamasına
  düşer ve orada da çözülemez; hiçbir şey sessizce yazılmaz. Aynı görev baseline kökte
  `--synthesize` ile çözülür.

**Önceki beceri non-inferiority:** anti-vakadan **sonra** learned arithmetic köküne yeni bir
aynı-aile görevi (`arith-regression`) verilir; process tasarrufu kalıcı olmalıdır.

**Restart:** her CLI çağrısı ayrı process'tir; eğitim sonrası journal store yeniden açılır ve
manifest `learningEligibility` girdileri kalıcılığı gösterilir. Eğitim kaynağı ve candidate
dosya hash'leri korunur.

**Hash:** her görevin `taskHash` ve `testHash`'i (sha256) raporlanır; baseline ve learned
kollar arasında birebir eşitliği test assert eder.

## 5. Split ve leakage

Holdout görevleri eğitim koşusuna giren içerikle üretilmez; eğitim ile holdout ayrık kaynak
dosyaları kullanır. Tüketilmiş #4341 holdout'u (first/second/third/fourth/fifth) bu kohortta
kullanılmaz. Aileler birbirinin belleğini kullanmaz (anti-vaka bunu sınar).

## 6. Metrikler ve yön

| Sıra | Metrik | Kollar | Yön | Rol |
|---|---|---|---|---|
| 1 | Doğruluk (holdout): `outcome=applied_tested` + `observedVerification.ok` + kaynak içerik beklenenle birebir eşit | paired | higher-is-better | H1a |
| 2 | Yanlış yazma sayısı (holdout + anti-vakalar + shift + non-inferiority) | learned | = 0 | REJECT eşiği |
| 3 | Toplam wall time (holdout, iki aile, eğitim dahil amortize) | baseline − (learned + eğitim) | lower-is-better | H1c |
| 4 | Doğrulama process sayısı (görev başına, aile bazında) | paired | lower-is-better | H1b (ikincil) |
| 5 | Farklı-aile aktarım sonucu | learned | rapor | anti-vaka |
| 6 | Attempt/rollback/tekrar-denetim sayıları | rapor | — | şeffaflık |
| 7 | CPU maliyeti | — | — | `NOT_MEASURED` |

## 7. Ön-kayıtlı eşikler (ölçümden önce kilitlendi; testte `CONTRACT` olarak da sabittir)

- `holdoutPerFamily` = 3 (altında `INSUFFICIENT`).
- `wrongWriteTolerance` = 0 → tek yanlış yazma `REJECT`.
- `perTaskProcessGain` = her holdout görevinde `learnedProcesses < baselineProcesses` (deterministik kapı).
- `amortizedWallGain` = `baselineHoldoutWallMs - learnedHoldoutWallMs - trainingWallMs > 0`.
  Geçmezse maliyet metni `INSUFFICIENT` raporlanır; doğruluk/metin kapıları etkilenmez.
- Zaman `process.hrtime.bigint()` ile ölçülür; CI'daki zaman iddiası tek koşum gözlemidir
  (eşik-raporu olarak değerlendirilir, CI assertion'ı olarak değil).

## 8. Fail-closed ve örnek yeterliliği

- Veri yok/yetersiz → `INSUFFICIENT`; ölçülemeyen boyut → `NOT_MEASURED`.
- Leakage, kollar arası bütçe farkı, görev hash eşitsizliği, `NaN/Infinity`, learned kolda
  yanlış yazma → `REJECT`.
- Farklı-aile aktarımı reddedilmezse veya kaynak dosya değişirse → `REJECT`.
- Bu küçük külliyat güç analizi değildir; aralık dar, genelleme sınırlıdır.

## 9. Kill / durdurma kriterleri

- Learned kol holdout doğruluğunu baseline'ın altına düşürürse → `REJECT`.
- Farklı-aile veya farklı-yöntem kontrolünde otomatik fallback / bellek sızması → `REJECT`.
- Aynı koşumun tekrarında deterministik sonuçlar (outcome/process sayıları) değişirse → `INSUFFICIENT`.

## 10. Kabul komutları

```sh
node --test test/coder-learning-g3-cohort.test.js
```

Rapor, eval testinin `t.diagnostic` JSON çıktısıdır: kohort digest'leri, aile/kol metrikleri,
amortizasyon ve anti-vaka sonuçları tek kayıtta.

## 11. Kapsam dışı (bilinçli)

- Cross-family transfer **yeteneği** (bu ölçüm yalnız mevcut davranışı, yani reddi raporlar).
- Production wiring; yeni receipt/wire/release; `intelligenceGain` sınıfı genel iddia.
- B4 tarzı evaluator mutant matrisi.
