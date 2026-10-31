# Coder öğrenme — G3 aileler-arası aktarım sonucu

**Ön-kayıt:** `docs/task-packs/coder-learning-g3-cross-family-preregistration-20261030.md`
(protokol ölçümden önce aynı PR'da kilitlendi).
**Base:** `5682e705` (origin/main). **Issue:** [#4415](https://github.com/ali-ulu/huqan/issues/4415).
**Eval:** `test/coder-cross-family-transfer.test.js` (`node --test test/coder-cross-family-transfer.test.js`).

## 1. Sonuç özeti

| Boyut | Sonuç | Verdict |
|---|---|---|
| Hedef holdout doğruluğu (3/3 `applied_tested`, `observedVerification.ok`) | 3/3 | **MEASURED** |
| Yanlış yazma (holdout + iki anti-vaka) | 0 (ölçüldü, sabit değil) | **eşik tetiklenmedi** |
| Görev başına process kazancı | 3/3 (baseline 8 → transfer 1) | **kanıtlandı** |
| Holdout sayısı (≥3) | 3 | **MEASURED** |
| Ayrık-gramer anti-vakası | `no_applicable_candidate`, kaynak değişmedi, 0 yazma | fail-closed |
| Başarısız aktarım anti-vakası | `transfer_verification_failed` + rollback, kaynak değişmedi | fail-closed |
| Restart kalıcılığı | journal yeniden açıldı, manifest korundu, aday değişmedi | sağlandı |
| CPU maliyeti | ölçülmedi (yeni bağımlılık olmadan çocuk-process CPU örneklemesi yok) | `NOT_MEASURED` |

**H1 verdict: `GAIN`.** H1a (doğruluk) ve H1b (görev başına process) birlikte sağlandı,
yanlış yazma 0.

## 2. Ölçüm (tek koşum, `t.diagnostic`)

- Eğitim: kaynak aile `arithmetic-expression`, 4 process / 864 ms.
- Hedef aile `conditional-expression`, 3 holdout:

| Görev | baseline process | transfer process | baseline ms | transfer ms |
|---|---|---|---|---|
| xfam-cond-one | 8 | 1 | 1193 | 694 |
| xfam-cond-two | 8 | 1 | 1117 | 689 |
| xfam-cond-three | 8 | 1 | 1097 | 692 |

- Toplamlar: baseline 24 process / 3407 ms; transfer 3 process / 2075 ms; eğitim 4 process / 864 ms.
- **Amortize edilmiş process tasarrufu: 24 − 3 − 4 = 17 process.**

## 3. Yorum

- **Aktarım çalışıyor ve hedef ailenin kendi doğrulamasından geçiyor.** Yalnız
  `arithmetic-expression` belleği olan bir kök, `conditional-expression` görevini
  `--adapt-memory` ile çözdü; hedef ailenin gerçek testi (`observedVerification.ok`)
  geçti. Bu, #4414'ün fail-closed reddinin yerini alan, **doğrulanmış** bir transfer yoludur.
- **Kazanç mekanizması dürüst.** Hedef ailenin yerel araması yalnız guard biçimlerini
  üretir; düz dal (`p % 2`) üretemez. Bu yüzden baseline hedef görevi bütçesi tükenene
  kadar (8 process) çözemez. Kaynak aile düz tam-sayı ifadelerini ürettiği için
  transfer, paylaşılan `integer-expression-ast` IR'ı üzerinden hedef gramere yeniden
  türetir ve ilk denemede çözer. Kazanç hem doğruluk hem process'tir.
- **Kapsam dar ve paylaşılan gramerle sınırlı.** Yeniden türetme yalnız hedef grameri
  paylaşılan IR'ı kapsayan aile için vardır (`conditional-expression`). Ayrık gramerli
  `string-expression` ve `array-fold` aktarımı **reddetmeye devam eder** — anti-vaka
  bunu `no_applicable_candidate` ile doğruladı. Aktarım, hedef ailenin ifade edemediği
  bir yöntem icat etmez.
- **Güvenlik değişmezleri tuttu.** Başarısız aktarım (`p % 2` yerine `abs(p)` isteyen
  hedef) `transfer_verification_failed` ile rollback edildi ve kaynağı değiştirmedi;
  hiçbir anti-vaka sessizce yazmadı. Yetki değişmedi: aktarım önerir, admission
  firewall + approval runtime'da kalır.

## 4. Sınırlar

- Tek koşum; duvar-saati bir gözlemdir, güç analizi değil. Külliyat küçük (1 kaynak
  eğitim + 3 hedef holdout).
- CPU maliyeti ölçülmedi (`NOT_MEASURED`).
- Bu sonuç genel bir "intelligenceGain" iddiası değildir; paylaşılan IR'a sahip iki
  aile üzerinde paired transfer ölçümüdür. `array-fold`/`string-expression` hedef
  aileler bu teslimde kapsam dışıdır (ayrık gramer).

## 5. Öneri

- Aileler-arası aktarım, paylaşılan IR'a sahip aile çiftinde **ölçülmüş bir kazanç**
  üretir; opt-in (`--adapt-memory`) kalır.
- Varsayılana terfi, bu ön-kayıtlı kapı **ve** #4060'ın geniş G3 kriterleri birlikte
  sağlanmadan yapılmaz.
- Ayrık gramerli hedef aileler için yeniden türetme yoktur; istenirse ayrı bir
  "grammar bridge" işi (her hedef aile için kendi IR köprüsü) gerekir.
