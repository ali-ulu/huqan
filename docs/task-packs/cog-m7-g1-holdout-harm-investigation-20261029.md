# M7 / G1 holdout ZARAR kök-neden incelemesi

**İlgili iş:** [#4381](https://github.com/ali-ulu/huqan/issues/4381)
(takip: #4065 tamamlanan ölçüm; epic #4060).
**Sonuç (değişmez):** `docs/task-packs/cog-m7-g1-holdout-result-20261028.md` — **ZARAR**.

Bu belge #4381 adım 3'ü karşılar: *"Inspect the raw report and source-bound
implementation to identify which urgency changes account for the loss."*
Ölçümü yeniden koşmaz, tüketilmiş holdout'u yeniden kullanmaz, hiçbir eşiği
değiştirmez ve hiçbir varsayılanı açmaz. Yalnız kayıtlı ham rapor ile kaynak
kodu bağlar.

## 1. Kaynak ve kanıt

| Alan | Değer |
| --- | --- |
| Ham rapor | `docs/task-packs/cog-m7-g1-holdout-report-20261028.json` |
| Rapor SHA-256 | `c4415351c9ed69ad4fbdf1f70a0d8942a1e7072a094b101eef102901ac3b32d9` |
| `manifestDigest` | `b80ddb7ecec4373d…` |
| `sourceSha` | `c28be307…` |
| Etiket / gerekçe | `ZARAR` / `interval_upper_below_zero` |
| Grup / seed | 32 grup × 3 seed = 96 seed |
| Aday / kontrol başarı | 103 / 128 (384 görev) |
| Grup farkı ortalaması | −0,065104 |
| %95 eşli bootstrap GA | [−0,111979, −0,020833] (10.000 tekrar, seed 20261027) |
| audit / reject / insufficient | CLEAN (400) / 0 / 0 |

Kaynak kod: `lib/cognitive-lab-m7-runtime.js`, `lib/agent-cognition-seam.js`,
`lib/cognition/salience.js`, `lib/cognitive-scheduler.js`,
`lib/cognitive-lab-g1-episode.js`, `lib/cognitive-lab-g1-holdout.js`.

## 2. Ölçüm tasarımı — yürütme bütçesi seçimi belirliyor

Epizot 4 onaylı görevden oluşur (`cognitive-lab-g1-episode.js`), ama bütçe
`maxSteps = 4, maxIterations = 2` (`:17`) ile **execution 2 göreve** kısıtlıdır
(`:117`). Yani sıralama, çalışan görev sayısını değil, **hangi 2 görevin
çalıştığını** belirler. Kayıp burada aranmalıdır.

**Kontrol kolu deterministiktir.** `m7-runtime.js:51` aday kontrol kolunda her
adımın `urgency = 0` yapar. `GOAL = 'build the approved computed APIs'` için
altı ailenin hepsi `keywordRelevance == 0` (kaynak kodla doğrulandı) ve
`objective` boş → `role = 0`. Bu yüzden kontrol, `order`'ın **ilk 2** görevini
koşar: 96/96 seed'de doğrulandı.

**Aday kolunda urgency aile düzeyindedir.** Seam `urgency = salience` yazar
(`agent-cognition-seam.js:105–107`); salience bileşenleri aile düzeyindedir
(`surprise` = `risk:${family}` özeti, `arousal` = `risk:${family}` ledger
girdisi). Sonuç: **96/96 seed'de urgency aile içinde sabittir**; 72/96 seed'de
tam olarak iki değer alır (bir aile yüksek, diğeri düşük). Yani aday, aileleri
görev görev değil **blok blok** yeniden sıralar.

## 3. Kaybın kaynağı — seçim değişimi (ölçüldü)

96 seed'in **68'inde** koşulan görev kümesi kontrol ile aday arasında değişir.
Değişimi tam olarak ayrıştırırsak:

| Kalem | done | error | toplam |
| --- | --- | --- | --- |
| Adayın eklediği (swap-in) | 41 | 41 | 82 |
| Adayın düşürdüğü (swap-out) | 66 | 16 | 82 |

Net başarı değişimi = `41 − 66 = **−25**`. Bu, gözlenen toplam farkla birebir
aynıdır: `128 − 103 = 25`. Aday başarısız görevleri dengeli (41/82) içeri alıp,
başarılı görevleri (66/82) dışarı atıyor. **Kayıp tek bir başarısız görevden
değil, seçim yer değiştirmesinden geliyor.**

## 4. Urgency, gerçek getiriyle ters korelasyonlu (kök neden)

72 iki-düzey seed'de, urgency'si **yüksek** olan ailenin kontrol başarı oranı
**0,466** (n=58); urgency'si **düşük** olan ailenin **0,773** (n=55). Yani M7
sinyali, synthetic Coder corpus'ta yüksek-surprise/yüksek-arousal aileyi öne
alıyor — ama o aile **daha düşük getirili**. 2-of-4 bütçesiyle bu, yüksek
getirili aileyi aç bırakıyor.

Aile bazında (kontrol → aday koşum sayısı ve başarı oranı):

| Aile | kontrol koşum/succ | aday koşum/succ |
| --- | --- | --- |
| array-fold | 38 / 36 (0,947) | 11 / 11 (1,000) |
| array-map | 39 / 36 (0,923) | 15 / 14 (0,933) |
| array-stateful-fold | 27 / 17 (0,630) | 30 / 24 (0,800) |
| array-filter | 36 / 19 (0,528) | 54 / 21 (0,389) |
| array-guarded-fold | 24 / 10 (0,417) | 22 / 9 (0,409) |
| array-threshold-fold | 28 / 10 (0,357) | 60 / 24 (0,400) |

Aday, yüksek getirili `array-fold`/`array-map` ailelerinin koşumunu 77 → 26'ya
düşürüp, düşük getirili `array-filter`/`array-threshold-fold` ailelerini
64 → 114'e çıkarıyor. Ön-kayıt §2 bu yönü açıkça öngörmüştü: *"Başarısızlıklar
türe göre kümeleniyorsa bu, başarı oranını düşürebilir. Zarar da kazanç kadar
raporlanır."*

## 5. Kök neden ifadesi

M7 salience, **aile-düzeyi** sürpriz/uyarılmadan urgency türetir ve 2-of-4
execution bütçesi altında **bütün aileleri** yeniden sıralar. Synthetic Coder
corpus'ta yüksek-surprise/yüksek-arousal aile = düşük-başarılı aile olduğundan,
sinyal sistematik olarak yanlış aileyi öne alır. Kayıp, `WEIGHT_AROUSAL`/
`W_SURPRISE` gibi tek bir ağırlıktan değil, **sinyalin aile düzeyinde
kaba-taneli olması + dar yürütme bütçesi** etkileşiminden gelir.

**Kapsam sınırı (§10 aynen).** Bu, sentetik ve model kullanmayan Coder
görevlerinde M7'nin seçim etkisidir. Gerçek mühendislik görev başarısını, G2/G3
kabulünü veya genel öğrenme kazancını kanıtlamaz. Tek-kullanımlık holdout bir
kez koşuldu; sonuç görüldükten sonra tasarım değiştirilmez.

## 6. Düzeltme yolu (öneri — bu PR'da uygulanmaz)

1. **Varsayılan değişmez.** Ölçülen zarar çözülene kadar salience opt-in kalır
   (`lib/cognition/cognition-config.js`: `salience` bayrağı yoksa tümü kapalı).
2. **Aday düzeltme** (ör. salience'ı aile blokları yerine görev/gözlenmiş
   getiri düzeyinde sıralamak, ya da düşük-güvenli aileyi öne almamak) yalnızca
   **yeni** bir ön-kayıtlı kohortta ölçülür; tüketilmiş holdout yeniden
   kullanılmaz (#4381 kabul kriteri).
3. **M9 katkısı ayrı.** Plan §9'un `arousalOff` kolu, urgency'nin arousal
   bileşenini izole etmek için yeni kohortta koşulur; M9 arousal'ın etkisi
   hâlâ `INSUFFICIENT`'tır ve tek başına bu incelemeden çıkarılamaz.
4. **Promotion** ancak yeni kohortta zarar-dışı sonuç **ve** G3 kriterleri
   (#4060) sonrası ayrı bir PR'da değerlendirilir.

Bu belge hiçbir kod, eşik, model veya üretim varsayılanını değiştirmez; yalnız
#4381'in "inspect" adımını kanıtla kapatır.
