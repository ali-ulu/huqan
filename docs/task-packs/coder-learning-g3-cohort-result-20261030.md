# Coder öğrenme kazanımı — G3 bağımsız kohort sonucu

**Ön-kayıt:** `docs/task-packs/coder-learning-g3-cohort-preregistration-20261030.md`
(protokol ölçümden önce aynı PR'da kilitlendi).
**Base:** `14871fea` (origin/main). **Issue:** [#4380](https://github.com/ali-ulu/huqan/issues/4380).
**Eval:** `test/coder-learning-g3-cohort.test.js` (`node --test test/coder-learning-g3-cohort.test.js`).

## 1. Sonuç özeti

| Boyut | Sonuç | Verdict |
|---|---|---|
| Holdout doğruluğu (2 aile × 3 görev = 6) | 6/6 `applied_tested`, `observedVerification.ok` | **MEASURED** |
| Yanlış yazma (holdout + anti-vaka + shift + non-inferiority) | 0 (ölçüldü, sabit değil) | **eşik tetiklenmedi** |
| Görev başına process kazancı | 6/6 (arith 4→1, string 3→1) | **kanıtlandı** |
| Holdout sayısı (aile başına ≥3) | 3 + 3 | **MEASURED** |
| Amortize duvar-saati kazancı (eğitim dahil) | **−1009 / −992 / −1096 ms** | **INSUFFICIENT** |
| Farklı-aile aktarımı (anti-vaka) | `no_applicable_candidate` reddi, dosya değişmedi | fail-closed |
| Farklı-yöntem kontrolü | bellek denemesi `transfer_verification_failed` + rollback; baseline taze aramada çözer | fail-closed |
| Dağılım kayması | shift 4→1, string-shift 3→1 | kazanç korundu |
| Restart kalıcılığı | journal yeniden açıldı, manifest `positive_procedure`/`negative_example` korundu | sağlandı |
| Önceki beceri non-inferiority | regression 4→1 (anti-vakalardan sonra) | sağlandı |
| CPU maliyeti | ölçülmedi (yeni bağımlılık olmadan çocuk-process CPU örneklemesi yok) | `NOT_MEASURED` |

**H1 (yönlü) verdict: `NOT_PROVEN`.** H1a (doğruluk) ve H1b (görev başına process)
kanıtlandı; H1c (amortize duvar-saati kazancı) eşiği geçmedi. Bu, H1'i bir bütün olarak
kanıtlanmamış bırakır — ön-kayıt §1/§8 fail-closed tanımı gereği.

## 2. Ölçüm (tek koşum, `t.diagnostic`)

- Eğitim: 2 aile, toplam 7 process / 1697 ms.
- Holdout (6 görev):

| Görev | Aile | baseline process | learned process | baseline ms | learned ms |
|---|---|---|---|---|---|
| first | arithmetic | 4 | 1 | 873 | 700 |
| second | arithmetic | 4 | 1 | 842 | 704 |
| third | arithmetic | 4 | 1 | 835 | 690 |
| string-one | string | 3 | 1 | 796 | 737 |
| string-two | string | 3 | 1 | 798 | 715 |
| string-three | string | 3 | 1 | 780 | 690 |

- Toplamlar: baseline 21 process / 4923 ms; learned 6 process / 4235 ms; eğitim 7 process / 1697 ms.
- **Amortize edilmiş process tasarrufu: 21 − 6 − 7 = 8 process.**
- **Amortize edilmiş duvar-saati kazancı: 4923 − 4235 − 1697 = −1009 ms** (negatif → `INSUFFICIENT`).
- İki bağımsız koşumda process sayıları ve görev/test hash'leri birebir aynı (deterministik);
  duvar-saati kazancı −1009 ms ve −992 ms → verdict her ikisinde de `INSUFFICIENT`
  (CodeRabbit düzeltmelerinden sonraki koşumda −1096 ms, aynı verdict).

## 3. Yorum

- **Process kazancı gerçek ve iki ailede de tutarlı.** Learned kol her holdout görevini tek
  doğrulama process'inde çözüyor; baseline arithmetic'te 4, string'de 3 process harcıyor.
  Kazanç mekanizması dürüst: baseline, eğitim örnekleriyle ayırt edilemeyen adayları tek tek
  deneyip her birinde bir process harcıyor; learned kol hatırlanan prosedürü ilk denemede
  uyguluyor.
- **Duvar-saati kazancı yok.** Process tasarrufu 8'e çıksa da, CLI başına sabit başlangıç
  maliyeti (kaynak doğrulama, qualification, yeniden doğrulama, kabul) baskın; tek koşumda
  eğitim maliyeti geri kazanılmıyor. Bu, #4341'in `amortizedWallGainMs: -167` sonucuyla
  aynı yöndedir ve **yeni bir kanıt değil, bağımsız bir teyittir**: dar aynı-yöntem
  kohortunun ötesine geçen ikinci ailede de duvar-saati kazancı çıkmıyor.
- **İkinci aile artık ölçülüyor.** #4380'un istediği "dar aynı-yöntem kohortunun ötesi"
  karşılandı: string/`trim+toLowerCase` ailesi, arithmetic'ten bağımsız olarak eğitildi ve
  değerlendirildi; process kazancı orada da tutarlı.
- **Farklı-aile aktarımı yok, fail-closed.** Yalnız arithmetic belleği olan bir kök,
  string görevini `no_applicable_candidate` ile reddetti ve kaynağı değiştirmedi. Bu,
  cross-family transfer yeteneğinin bu ölçümde **mevcut olmadığını** gösterir (programın
  bilinçli kapsamı dışı; §11).
- **Güvenlik değişmezleri tuttu.** Hiçbir anti-vaka veya kontrol, sessizce yazmadı;
  rollback ve taze-arama fallback davranışı beklendiği gibi fail-closed.

## 4. Sınırlar

- Tek koşum; duvar-saati bir gözlemdir, güç analizi değil. Külliyat küçük (2 aile × 3 holdout).
- CPU maliyeti ölçülmedi (`NOT_MEASURED`).
- Bu sonuç `intelligenceGain` sınıfı genel bir iddia değildir; iki aileli sabit, sınırlı
  grammar üzerinde paired transfer ölçümüdür.

## 5. Öneri

- **Doğruluk + process kazancı** kanıtlanmıştır; **duvar-saati kazancı** kanıtlanmamıştır.
  Bir sonraki adım (B = cross-family transfer), bu ölçümün gösterdiği boşluğu (aileler arası
  paylaşım yok) hedefler; bu PR onu kapsamaz.
- Maliyet iddiasını kurmak isteyen iş, CLI başına sabit maliyeti (doğrulama/qualification
  yolu) düşürmeyi ölçmelidir; process sayısı tek başına duvar-saatine dönüşmüyor.
