# M7 / G1 düzeltme kohortu ölçüm sonucu — MEASURED_NO_GAIN

**Ön-kayıt:** `docs/task-packs/cog-m7-g1-correction-preregistration-20261029.md`
(KİLİTLİ, sahip onayı 2026-10-29; tasarım `cog-m7-g1-holdout-preregistration-20261027.md`
sürüm 3 §12 ile aynı, yalnız seed `20261029` ve aday düzeltmesi farklı).
**Kalibrasyon kilidi:** `docs/task-packs/cog-m7-g1-correction-calibration-manifest-20261029.json`
(`sourceSha` `1dfd2d32`, `corpusDigest` `ba63c20a…`, `lock.holdoutGroups` 32, σ = 0,220198).
**İlgili iş:** #4387 (düzeltme + yeni kohort), #4381 (zarar atfı), #4065 (tüketilmiş
M7/G1 ölçümü), epic #4060 (G3). **Bu belge yalnız yeni ve bağımsız kohortu raporlar;
tüketilmiş 2026-10-27 holdout'u yeniden kullanılmadı, ona göre ayar yapılmadı.**

## 1. Sonuç

**Etiket: MEASURED_NO_GAIN.** Gerekçe: `interval_includes_zero`.

Düzeltilmiş M7 urgency katkısı, epizot başına bağımsız kabulü geçen görev oranını
kontrolden **ayırt edilebilir biçimde değiştirmedi**: %95 eşli bootstrap GA sıfırı
içeriyor. Ön-kayıt §2 iki yönlü hipotez kurmuştu ve kazanç önceden iddia edilmemişti;
sonuç ne GAIN ne ZARAR'dır.

| Ölçü | Değer |
| --- | --- |
| Grup sayısı | 32 (`lock.holdoutGroups`), her grup 3 seed |
| Aday başarı oranı | 132 / 384 = **0,3438** |
| Kontrol başarı oranı | 139 / 384 = **0,3620** |
| Grup farkı ortalaması | **−0,0182** |
| %95 eşli bootstrap GA | **[−0,0547, +0,0182]** (10.000 tekrar, seed 20261027) |
| İşaret testi | 9 pozitif / 12 negatif / 11 eşit, p = **0,6636** |
| audit | CLEAN (400 birim) |
| reject / insufficient | 0 / 0 |

GA üst sınırı +0,0182 ≥ 0 olduğu için etiket GAIN değildir; alt sınır −0,0547 ≤ 0
olduğu için ZARAR da değildir. Ön-kayıt §7 önceliğinde sonuç **MEASURED_NO_GAIN**
(öncelik: sıfırı içeren GA) olarak seçilir.

## 2. Tüketilmiş kohortla karşılaştırma (bilgi amaçlı, karar girdisi değil)

| | 2026-10-27 (tüketilmiş) | 2026-10-29 (bu kohort) |
| --- | --- | --- |
| Etiket | **ZARAR** | **MEASURED_NO_GAIN** |
| Aday / kontrol | 103 / 128 (384) | 132 / 139 (384) |
| Grup farkı ortalaması | −0,0651 | −0,0182 |
| %95 GA | [−0,1120, −0,0208] | [−0,0547, +0,0182] |
| İşaret testi p | 0,0127 | 0,6636 |

Düzeltme, ölçülen zararı **istatistiksel olarak anlamlı olmaktan çıkardı** (GA artık
sıfırı içeriyor), ama sıfır-dışı bir kazanç **göstermedi**. İki kohort bağımsızdır;
bu karşılaştırma yalnız yön bilgisidir, bir hipotez testi değildir ve hiçbir karar
kuralı buna dayanmaz (ön-kayıt §3).

## 3. Non-inferiority ve maliyet

- **Alt tabaka:** 4 grup, `minStratumGroups` 8'in altında (§12'de holdout'tan önce
  yazılıydı). §7 boş/az-alt-tabaka kuralı: **GAIN verilemez**. Bu sonuç zaten
  MEASURED_NO_GAIN'dir; kural GAIN'i dışlar, etiketi değiştirmez.
- **Maliyet:** model çağrısı 0, ağ çağrısı 0. Duvar süresi medyanı oranı **1,031**
  (eşik ≤ 1,5 ✓). 384 Coder adımı.

## 4. Aile bazında kırılım

Her grup iki farklı aileden birer birim içerir (§12); aşağıda koşum sayısı ve başarı
oranı ile grup farkı ortalaması ailelere dağıtılmıştır.

| Aile | Kontrol koşum/succ | Aday koşum/succ | Ortalama grup farkı |
| --- | --- | --- | --- |
| array-filter | 32/108 (0,296) | 33/108 (0,306) | +0,0093 |
| array-fold | 34/84 (0,405) | 36/84 (0,429) | +0,0238 |
| array-guarded-fold | 58/156 (0,372) | 57/156 (0,365) | −0,0064 |
| array-map | 51/120 (0,425) | 45/120 (0,375) | −0,0500 |
| array-stateful-fold | 50/156 (0,321) | 42/156 (0,269) | −0,0513 |
| array-threshold-fold | 53/144 (0,368) | 51/144 (0,354) | −0,0139 |

32 grubun 9'unda fark pozitif, 12'sinde negatif, 11'inde sıfırdır. Yeni kohortta
zarar tek bir aileye özgü değil ve küçüktür; düzeltme yüksek-getirili ailelerin
(`array-fold`) öne çıkmasını engellemiyor, ama onları sistematik olarak da öne
almıyor.

## 5. Ön-kayıtla uyum

- §1: giriş üretim HTTP yolu; onay ayrı operatör yetkisiyle. Aday kol düzeltilmiş
  seam'dir (aile seviyesinde kanıtlanmış negatif değere sahip aile kendi başarısızlık
  kaydıyla terfi edemez); salience formülü (`DEFAULT_WEIGHTS`) değişmedi.
- §3: seed `20261029`; `corpusDigest` `ba63c20a…`, tüketilmiş kohorttan (`360ad702…`)
  farklı, grup örtüşmesi yok.
- §4: bölme denetleyicisi çalıştı (audit CLEAN, 400 birim); sızıntı bulunmadı.
- §5: epizot = 4 onaylı görev, `maxSteps = 4`, `maxIterations = 2`, `maxEpisodeSteps = 6`;
  kuyruk seed'le karıştırıldı.
- §6: σ̂ = 0,220198 (yeni kalibrasyondan, 8 grup n − 1), N = 32 kilitli.
- §7: GA eşli bootstrap; alt tabaka tedavi öncesi yeni train snapshot'ından tanımlandı;
  etiket öncelikli kümeden seçildi.
- §8: mutasyon yeni kalibrasyonda INTACT (gözlem kesikken urgency dondu, açıkken
  değişti); anti-vakalar (`noFailure`, `bothFail`, `singleKind`) INTACT.
- §12: kalibrasyon kilidi güncel `main`'e (`1dfd2d32`) dayandırıldı; hipotez, N,
  seed'ler ve karar kuralları tüketilmiş kohortla aynıdır.

## 6. Kapsam ve iddia sınırı

§10 aynen geçerlidir: bu ölçüm, sentetik ve model kullanmayan Coder görevlerinde M7'nin
seçim etkisini ölçer. Gerçek mühendislik görev başarısını, G2/G3 kabulünü veya genel
öğrenme kazancını kanıtlamaz. Bu kohortun holdout'u tek kullanımlıktır ve bir kez
koşulmuştur; sonuç görüldükten sonra tasarım değiştirilmez.

**Tüketilmiş 2026-10-27 ZARAR sonucu görünür kalır ve geçti olarak yeniden
etiketlenmez** (#4387 kabul kriteri).

**Üretim varsayılanı değişmez** (§7 son madde): hiçbir etiket üretim varsayılanını
kendiliğinden değiştirmez; cognition opt-in kalır. Promotion ancak GAIN/zarar-dışı bir
sonuç **ve** G3 (#4060) kriterleri sonrası ayrı bir PR'da değerlendirilir; bu sonuçla
promotion **yapılmaz**.

**M9 arousal etkisi bu belge kapsamı dışındadır.** Plan §9'un `arousalOff` kolu ayrı
bir çalışmadır (#4388); bu düzeltme arousal'ı yalnız negatif-değerli ailede çeker,
arousal bileşeninin tek başına etkisini izole etmez.

## 7. Kanıt

Ham holdout raporu: `docs/task-packs/cog-m7-g1-correction-holdout-report-20261029.json`
(`manifestDigest` `a3b298a3…`, `sourceSha` `1dfd2d32`). Deterministik alanlar
(`deltas`, `interval`, `signTest`) seed'e bağlıdır; yalnız `cost` (duvar süresi/bellek)
alanları makine hızına göre değişir.
