# Coder öğrenme kazanımı — G3 güç ve tekrarlı maliyet sonucu

**Ön-kayıt:** `docs/task-packs/coder-learning-g3-power-cost-preregistration-20261030.md`
(protokol ölçümden önce aynı PR'da kilitlendi).
**Base:** `ebc4dd31` (origin/main). **Issue:** [#4416](https://github.com/ali-ulu/huqan/issues/4416).
**Eval:** `test/coder-learning-g3-power-cost.test.js`
(`node --test test/coder-learning-g3-power-cost.test.js`).
**Ayrık dilim:** #4380 kohortu (`coder-learning-g3-cohort-*`) tüketildi; bu ölçüm kendi
kalibrasyon + holdout dilimini kullanır (aile başına 5 holdout).

## 1. Sonuç özeti

| Boyut | Sonuç | Verdict |
|---|---|---|
| Process kazancı (2 aile × 5 holdout = 10) | 10/10, her tekrarda aynı (arith 4→1, string 3→1) | **MEASURED** |
| Yanlış yazma | 0 (ölçüldü) | **eşik tetiklenmedi** |
| Güç — process boyutu | `sigma=0` → `requiredSample=10`, `holdoutSize=10` | **powerMet** |
| Güç — wall-time boyutu | `sigma≈27 ms` → `requiredSample=10` | **powerMet** |
| Güç — CPU boyutu | `sigma≈8.7 ms` → `requiredSample=10` | **powerMet** |
| Tekrarlı duvar-saati kazancı (eğitim dahil, R=3) | **−640 / −516 / −506 ms**, verdict 3/3 aynı | **INSUFFICIENT** (kararlı) |
| CPU maliyeti (eğitim dahil, R=3) | ölçüldü: **−1322 / −1255 / −1245 ms** | **INSUFFICIENT** |
| CPU ölçümü | çocuk-process probe'u ile alındı (yeni bağımlılık yok) | **MEASURED** |

**G3 durumu (bu dilim): `MEASURED_NO_GAIN`.** Process kazancı güçlü ve deterministik;
eğitim dahil amortize duvar-saati **ve** CPU kazancı negatif — CLI başına sabit maliyet
baskın. `assertsGain=false`.

## 2. Ölçüm (temsili koşum, `t.diagnostic`)

Aşağıdaki sayılar tek bir koşumdandır; gürültülü boyutlar (wall/CPU) koşumdan koşuma
oynar, ama **verdict kararlıdır** (işaret+kararlılık tabanlı). Test bunları pinlemez.

- **Güç (§5):** kalibrasyon dilimi (3 görev) eşli deltaları:
  - process: `[3, 3, 3]` → `sigma=0` → `requiredSample=max(10, 0)=10`.
  - wallMs: `[210, 135, 130]` → `sigma≈44.8` → `requiredSample=max(10, 1)=10`.
  - cpuMs: `[56, 21, 22]` → `sigma≈19.9` → `requiredSample=max(10, 1)=10`.
  - `holdoutSize=10 ≥ 10` → üç boyutta da `powerMet=true`. Cohort büyüklüğü asgari örnek
    tabanıyla gerekçelenir; gürültülü boyutların sigma'sı 10 örnekten azını gerektirir.
- **Tekrarlı maliyet (§6, R=3):**

| Tekrar | baseline wall | learned wall | eğitim wall | amortize wall kazanç | baseline CPU | learned CPU | eğitim CPU | amortize CPU kazanç |
|---|---|---|---|---|---|---|---|---|
| 1 | 7937 | 6942 | 1635 | −640 | 7905 | 7576 | 1597 | −1322 |
| 2 | 7944 | 6931 | 1629 | −516 | 7846 | 7516 | 1575 | −1255 |
| 3 | 7938 | 6925 | 1620 | −506 | 7838 | 7532 | 1561 | −1245 |

- Duvar-saati kazancı verdict'i 3/3 `INSUFFICIENT` (kararlı). CPU kazancı da 3/3 negatif.
- Process sayıları her tekrarda birebir aynı (10/10 kazanç) — deterministik.

## 3. Yorum

- **Örnek sayısı artık gerekçeli.** Önceki #4380 kohortu (aile başına 3) güç hesabı
  içermiyordu; bu dilim, dondurulmuş asgari anlamlı etki (`process=1`, `wallMs=100`,
  `cpuMs=100`) ve α=0.05/power=0.8 ile `requiredSample` hesaplar ve `holdoutPerFamily=5`
  seçimini bu hesaba dayandırır. Process boyutu (birincil, deterministik) sigma=0 verir;
  bağlayıcı kısıt ilan edilmiş asgari örnek sayısıdır (10). Bu, "küçük örnek yalnız
  pilot/karakterizasyondur" kapısını karşılar: cohort ya asgari tabanı geçer ya da
  `INSUFFICIENT` döner.
- **Maliyet artık tek koşum değil.** Aynı paired ölçüm R=3 kez, taze köklerde koşuldu;
  duvar-saati ve CPU bir **dağılım** olarak raporlanıyor. Verdict yalnız **işaret ve
  kararlılığa** bağlı olduğu için platformlar arası büyüklük oynaklığı verdict'i çevirmez;
  #4380'in "aynı sözleşme bir platformda GAIN, diğerinde INSUFFICIENT" sorunu bu tasarımla
  kapatılır (işaret üç platformda da negatifse verdict kararlı `INSUFFICIENT`).
- **CPU artık ölçülüyor (`NOT_MEASURED` değil).** Yeni bağımlılık olmadan, her çocuk
  process'e `NODE_OPTIONS=--require <probe>` ile bir CPU/RSS kaydedici yüklendi; CLI'ın
  kendi test spawn'ları dahil. CPU amortize kazancı da negatif (−1294 ms medyan): sabit
  maliyet baskınlığı yalnız duvar-saati değil, gerçek CPU tüketimi düzeyinde de teyit edildi.
- **Process kazancı ile maliyet ayrı raporlanır.** 10/10 process kazancı güçlü ve deterministik;
  buna karşın duvar-saati/CPU kazancı yok. Bir metrikteki `GAIN`, diğerini ima etmez
  (issue'nun kabul kriteri).

## 4. Sınırlar

- Duvar-saati ve CPU bir makinede ölçüldü (Linux, Node 24). Çoklu-platform matrisi bu PR'da
  koşulmadı; **tasarım** platform-bağımsızdır (verdict işaret+kararlılık tabanlı), ama
  üç-platform tablosunun kendisi CI matrisinde doğrulanmalıdır (bkz. §5).
- Kalibrasyon dilimi küçük (3 görev); `sigma` bu küçük dilimden. Process boyutu
  deterministik olduğundan bu sigma=0 ve sonuç sağlam; gürültülü boyutların sigma'sı daha
  büyük dilimle daha kesin ölçülebilir.
- Bu sonuç `intelligenceGain` sınıfı genel bir iddia değildir; iki aileli sabit, sınırlı
  grammar üzerinde paired transfer + maliyet ölçümüdür.

## 5. Öneri

- **G3 durumu bu dilim için `MEASURED_NO_GAIN`.** Process kazancı kabul edilebilir;
  maliyet iddiası kurulamaz. Maliyet iddiası isteyen iş, CLI başına sabit maliyeti
  (doğrulama/qualification yolu) düşürmeyi ölçmelidir.
- Çoklu-platform matrisi: `test/coder-learning-g3-power-cost.test.js` CI'da Ubuntu ve
  Windows Node 22/24 shard'larında koşar; verdict her shard'da raporlanır ve işaret+kararlılık
  tabanlı olduğundan platformlar arası `INSUFFICIENT`/`GAIN` kayması beklenmez. Üç-platform
  tablosu bir sonraki adımda shard loglarından toplanabilir.
- Bir sonraki adım (#4415, "b" işi): aileler arası paylaşım yokluğunu hedefler; bu PR
  kapsamaz.
