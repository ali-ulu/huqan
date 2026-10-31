# Coder öğrenme — G3 aileler-arası aktarım ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Külliyat (§4), metrikler (§6) ve eşikler
(§7) bu commit ile donduruldu. Ölçüm bu commit'ten **sonra** koşulur; sonuç ayrı bir
belgede raporlanır (`coder-learning-g3-cross-family-result-20261030.md`).
**Base:** `5682e705` (origin/main). **Issue:** [#4415](https://github.com/ali-ulu/huqan/issues/4415).
**Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060) (G3 — birleşik sistem kabulü).
**Önceki ölçüm:** `coder-learning-g3-cohort-result-20261030.md` (#4380/#4414) ve
`coder-learning-g3-power-cost-result-20261030.md` (#4416/#4417). Bu belge **onların
külliyatını kullanmaz**; yeni aile çifti ve yeni görev adları aşağıda dondurulmuştur.

## 0. Amaç ve sınır

#4415 iddiasını ölçer: bir ailede öğrenilen prosedür, **ikinci ve bağımsız olarak
eğitilmiş** bir aileye, hedef ailenin kendi doğrulaması altında yeniden türetilip
aktarılabilir mi — doğruluğu düşürmeden ve yetki sızdırmadan?

Sınırlar:
- **Paylaşılan gramer şartı.** Yeniden türetme yalnız iki aile ortak bir gösterimi
  paylaşınca anlamlıdır. Bu kohort `arithmetic-expression` (kaynak) ve
  `conditional-expression` (hedef) çiftini kullanır: ikisi de `lib/experience/
  integer-expression-ast.js` IR'ını paylaşır, bu yüzden bir yeniden türetme vardır.
  `string-expression` ve `array-fold` gramerleri bu IR'dan **ayrıktır**; onlara
  yeniden türetme yoktur ve aktarım fail-closed reddetmeye devam eder (§5 anti-vaka).
- Bu bir **gain iddiası değil**, ölçüm protokolüdür. Sonuç ne çıkarsa `GAIN` /
  `INSUFFICIENT` / `MEASURED_NO_GAIN` / `REJECT` olarak olduğu gibi raporlanır.
- Yetki değişmez: aktarım yalnız **önerir**; kabul mevcut firewall + approval
  runtime'da kalır. Aktarılan prosedür hedef ailenin gerçek testini geçmeden yazılmaz.

## 1. Hipotezler

- **H0:** Aileler-arası aktarım, hedef ailenin holdout görevlerinde doğru sonucu
  üretmez veya görev başına doğrulama process'ini baseline'ın altına düşürmez.
- **H1 (yönlü):** Aileler-arası aktarım (a) her hedef holdout görevinde, hedef ailenin
  kendi testini geçerek doğru sonucu üretir (yanlış yazma 0), (b) paired her hedef
  görevde baseline'dan daha az doğrulama process'i kullanır.

**Neden baseline'ın kendisi çözemez.** Hedef aile `conditional-expression`'ın yerel
araması yalnız **guard** biçimlerini üretir; düz dal (`p % 3`) üretemez
(`lib/coder/conditional-expression-search.js`). Kaynak aile `arithmetic-expression`
ise düz tam-sayı ifadelerini üretir. Bu yüzden bu kohortta baseline, hedef görevi
bütçesi tükenene kadar çözemez; transfer, paylaşılan IR üzerinden çözer. Ölçülen
kazanç hem doğruluk hem process'tir.

## 2. Gerçeklik sınırı

Ölçüm `cli.js coder <task> --synthesize / --adapt-memory` gerçek giriş noktası
üzerinden, gerçek geçici Git depolarında koşar. Kaynak aile `arithmetic-expression`;
hedef aile `conditional-expression`. İkisi **bağımsız** eğitilir: hedef ailenin
hiçbir görevi kaynak eğitiminde kullanılmaz.

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Aile başına taze çalışma kökü; hedef holdout görevleri `--synthesize`. |
| Transfer kolu | Kaynak aile eğitim görevi `--synthesize` + `rememberFile` ile koşulur; hedef holdout görevleri `--adapt-memory` ile. |
| Eşit bütçe | Her iki kol `BUDGET = 8` process limiti; aynı görev hash'leri, aynı kaynak içerik, aynı test komutları. |

## 4. Külliyat (ölçümden önce kilitlendi)

**Kaynak aile — `arithmetic-expression`** (buggy `m + 1`, hedef `m % 2`):
- Eğitim: `xfam-arith-train` (`m`, örnek `[0,4,8]`→`0`, test `[9,14]`→`[1,0]`).
  Eğitim örnekleri çift olduğu için parite buggy gövdeden örneklerle ayrılamaz;
  gerçek test karar verir. Adlar ve değerler yeni (#4380 külliyatı kullanılmaz).

**Hedef aile — `conditional-expression`** (buggy `fn(p) { return p + 1; }`, hedef `p % 2`).
Sentez örnekleri çift (`0` döndürür, birden çok guard biçimi eşleşir); gerçek test
tek girdileri kullanır (`p % 2` gerekir). Örnekler arama sırasını belirler, test
sonucu belirlemez.
- Holdout (N = 3): `xfam-cond-one` (`scale`/`input`, örnek `[0,6,10]`, test `[17,24]`→`[1,0]`),
  `xfam-cond-two` (`offset`/`item`, örnek `[0,12,16]`, test `[19,28]`→`[1,0]`),
  `xfam-cond-three` (`shift`/`entry`, örnek `[0,18,22]`, test `[23,32]`→`[1,0]`).

**Anti-vakalar:**
- **Ayrık gramer (fail-closed):** yalnız `arithmetic-expression` belleği olan bir kökte
  `string-expression` görevi (`xfam-string-disjoint`, `shout`/`word`) `--adapt-memory`
  ile koşulur. Beklenen: `no_applicable_candidate` reddi, kaynak değişmez, yazma yok.
- **Başarısız aktarım (rollback):** hedef görev (`xfam-cond-fail`, `repair`/`value`,
  örnek `[0,6,10]`, test `[-4,7]`→`[4,7]` yani `abs(p)`) kaynak prosedürünün
  ürettiğinden (`p % 2`) farklı bir sonuç ister. Beklenen: hedef testte
  `transfer_verification_failed` + doğrulanmış rollback, dosya değişmez, yazma yok.

## 5. Doğruluk yüklemi ve yanlış yazma

- Doğru sonuç: hedef görev `applied_tested` ve `record.observedVerification.ok === true`.
- Yanlış yazma: holdout + anti-vaka koşumlarının hiçbirinde beklenen changed-set dışı
  dosya değişmemesi. Tolerans `0`; ölçülür, sabit okunmaz.

## 6. Metrikler ve yön

| Sıra | Metrik | Kollar | Yön | Rol |
|---|---|---|---|---|
| Primer | doğru-sonuç oranı (hedef holdout) | transfer − baseline, paired | higher-is-better | H1a |
| Primer | görev başına doğrulama process'i | transfer − baseline, paired | lower-is-better | H1b |
| Güven | yanlış yazma sayısı | transfer | = 0 | REJECT eşiği |
| Rapor | hedef aile başına process ve duvar-saati | her iki kol | — | maliyet |

## 7. Eşikler ve verdict sözlüğü

- `holdoutPerFamily = 3`; `budget = 8`; `wrongWriteTolerance = 0`.
- `GAIN`: H1a ve H1b birlikte sağlanır ve yanlış yazma 0.
- `MEASURED_NO_GAIN`: ölçüm geçerli (test exit 0) ama process kazancı çıkmaz.
- `INSUFFICIENT`: holdout sayısı eşiği tutmaz veya bir kapı ölçülemez.
- `REJECT`: yanlış yazma > 0 ya da güvenlik değişmezi ihlali.

## 8. Kapsam ve terfi

- Aktarım **opt-in** kalır (`--adapt-memory`). Varsayılana terfi, bu ön-kayıtlı kapı
  **ve** #4060'ın geniş G3 kriterleri birlikte sağlanmadan yapılmaz.
- Yetki sınırı değişmez: aktarım skorlar/önerir; admission mevcut firewall + approval
  runtime'da kalır.
