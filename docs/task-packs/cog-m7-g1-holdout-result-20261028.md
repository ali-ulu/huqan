# M7 / G1 holdout ölçüm sonucu — ZARAR

**Ön-kayıt:** `docs/task-packs/cog-m7-g1-holdout-preregistration-20261027.md` (KİLİTLİ, sürüm 3 §12).
Bu belge onu **değiştirmez**; ön-kayıt §7 son maddesi gereği sonuç ayrı rapor olarak verilir.
**Kalibrasyon kilidi:** `docs/task-packs/cog-m7-g1-calibration-manifest-20261027.json`
(`sourceSha` `c28be307`, `lock.holdoutGroups` 32).
**İlgili iş:** #4065 (G1 sahibi), epic #4060.

## 1. Sonuç

**Etiket: ZARAR (harm).** Gerekçe: `interval_upper_below_zero`.

M7 urgency katkısı, epizot başına bağımsız kabulü geçen görev oranını kontrole göre
**düşürdü**. Ön-kayıt §2 bu yönü açıkça öngörmüştü: *"Başarısızlıklar türe göre
kümeleniyorsa bu, başarı oranını düşürebilir. Zarar da kazanç kadar raporlanır."*

| Ölçü | Değer |
| --- | --- |
| Grup sayısı | 32 (`lock.holdoutGroups`), her grup 3 seed |
| Aday başarı oranı | 103 / 384 = **0,2682** |
| Kontrol başarı oranı | 128 / 384 = **0,3333** |
| Grup farkı ortalaması | **−0,0651** |
| %95 eşli bootstrap GA | **[−0,1120, −0,0208]** (10.000 tekrar, seed 20261027) |
| İşaret testi | 3 pozitif / 14 negatif / 15 eşit, p = **0,0127** |
| audit | CLEAN (400 birim) |
| reject / insufficient | 0 / 0 |

GA üst sınırı −0,0208 < 0 olduğu için etiket ZARAR'dır (§7 öncelik 3). Bu etiket
kazançtan bağımsız raporlanır.

## 2. Non-inferiority ve maliyet

- **Alt tabaka:** 3 grup, `minStratumGroups` 8'in altında (§12'de holdout'tan önce
  yazılıydı). §7 boş/az-alt-tabaka kuralı: **GAIN verilemez**; etiket GA'ya göre
  seçilir. GA üst sınırı < 0 olduğundan sonuç ZARAR'dır, `INSUFFICIENT`'a eşlenmez.
- **Maliyet:** model çağrısı 0, ağ çağrısı 0. Duvar süresi medyanı oranı **1,043**
  (eşik ≤ 1,5 ✓). 384 Coder adımı.

## 3. Aile bazında kırılım

Her grup iki farklı aileden birer birim içerir (§12); aşağıda grup farkı ilgili
ailelere dağıtılmıştır.

| Aile | Grup | Ortalama grup farkı |
| --- | --- | --- |
| array-threshold-fold | 10 | −0,1083 |
| array-filter | 10 | −0,1000 |
| array-fold | 12 | −0,0764 |
| array-map | 13 | −0,0641 |
| array-stateful-fold | 10 | −0,0250 |
| array-guarded-fold | 9 | −0,0093 |

32 grubun 3'ünde fark pozitif, 14'ünde negatif, 15'inde sıfırdır. Zarar tek bir
aileye özgü değil; en çok `array-threshold-fold` ve `array-filter` ailelerinde.

## 4. Ön-kayıtla uyum

- §1: giriş üretim HTTP yolu; onay ayrı operatör yetkisiyle. Runner tarafından uygulandı.
- §4: bölme denetleyicisi çalıştı (audit CLEAN, 400 birim); sızıntı bulunmadı.
- §5: epizot = 4 onaylı görev, `maxSteps = 4`, `maxIterations = 2`; kuyruk seed'le karıştırıldı.
- §6: σ̂ = 0,09383 (kalibrasyondan), N = 32 kilitli.
- §7: GA eşli bootstrap; alt tabaka tedavi öncesi tanımlı; etiket öncelikli kümeden seçildi.
- §8: mutasyon calibration'da INTACT (gözlem kesikken urgency dondu, açıkken değişti).
- §12: kalibrasyon kilidi güncel `main`'e (`c28be307`) yeniden dayandırıldı; hipotez, N,
  seed'ler ve karar kuralları değişmedi.

## 5. Kapsam ve iddia sınırı

§10 aynen geçerlidir: bu ölçüm, sentetik ve model kullanmayan Coder görevlerinde M7'nin
seçim etkisini ölçer. Gerçek mühendislik görev başarısını, G2/G3 kabulünü veya genel
öğrenme kazancını kanıtlamaz. Tek kullanımlık holdout bir kez koşulmuştur; sonuç
görüldükten sonra tasarım değiştirilmez.

**Üretim varsayılanı değişmez** (§7 son madde): hiçbir etiket üretim varsayılanını
kendiliğinden değiştirmez; cognition opt-in kalır.

## 6. Kanıt

Ham holdout raporu: `docs/task-packs/cog-m7-g1-holdout-report-20261028.json`
(`manifestDigest` `b80ddb7e…`, `sourceSha` `c28be307`). Deterministik alanlar
(`deltas`, `interval`, `signTest`) seed'e bağlıdır; yalnız `cost` (duvar süresi/bellek)
alanları makine hızına göre değişir.
