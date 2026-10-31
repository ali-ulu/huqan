# M3/B4 replay seçimi — ölçüm sonucu (karakterizasyon)

**Ön-kayıt:** `docs/task-packs/cog-m3-replay-preregistration-20261027.md` (KİLİTLİ).
Bu belge onu **değiştirmez**; ön-kayıt §6 gereği sonuç ayrı rapor olarak verilir.
**İş:** [#4069](https://github.com/ali-ulu/huqan/issues/4069). **Epic:** [#4060](https://github.com/ali-ulu/huqan/issues/4060).
**Önceki durum raporu:** `docs/task-packs/cog-m3-b4-replay-status-20261029.md` (`NOT_RUN`).
**Eval:** `test/cognition-replay-b4-characterization.test.js` (`node --test test/cognition-replay-b4-characterization.test.js`).

## 1. Sonuç

**Etiket: KARAKTERİZASYON (characterization), gain iddiası yok.**

Ölçüm yüzeyi çalışır: donmuş bir epizot korpusu üzerinde **gerçek** seçim
modülleri ve **gerçek** B4 değerlendiricisi koşar ve iki seçim sırası
(priority top-K vs recent-K) görev görevinde ayrışır. Ancak bu, ön-kayıt §9'daki
**H1 deneyi değildir**: H1, adayların bağımsız holdout görevlerine gerçek Coder
runtime üzerinden uygulanmasını gerektirir ve ön-kayıt §6'nın açık bıraktığı
aile-düzeyi paired adapter + kilitli split manifesti olmadan koşulamaz. O kol
`NOT_RUN` olarak raporlanır, burada taklit edilmez.

| Ölçü | Değer |
| --- | --- |
| Yüzey | `groupForCandidates` (A2 priority) vs `groupForRecentCandidates` (A1 recent-K) |
| Değerlendirici | `lib/cognitive-lab-b4-evaluator.js::evaluate`, kilitli B4 kontratı |
| Korpus | 32 görev (24 holdout, 8 transfer), donmuş; digest `5fa51be0…` |
| Durum | `MEASURED` |
| Gerekçe | `interval_below_meaningful_effect` |
| Doğru (holdout) | A0 5, A1 19, A2 19, O 24 |
| Doğru (transfer) | A0 2, A1 6, A2 6, O 8 |
| Eşli fark A2−A1 | ortalama **0**, %95 GA **[−0,25, 0,25]** |
| Eşli fark A2−A0 | ortalama **+0,5833**, %95 GA **[0,375, 0,75]** |
| Yanlış yazma | A0 0, A1 0, A2 0 |
| `clearsEffect` | **false** |
| `assertsGain` | **false** |
| `intelligenceGain` | `NOT_MEASURED` |

A2−A0 ikincil farkı pozitiftir (replay seçimi, seçim yapmayan baseline'dan daha
çok etiketli prosedür kurtarır), ama **birincil** A2−A1 farkı dengeli tasarımda
sıfırdır. Etiket bu yüzden `MEASURED_NO_GAIN` değil **karakterizasyon**dur:
korpus istatistiksel bir örnek değil, sabit bir fikstürdür (§5).

## 2. Korpus ve kategori ayrımı

Her görev tek bir `(workspaceId, key, frameTask)` grubudur; sınıflar yalnızca
**hangi epizotların daha yeni** ve **sinyal büyüklüklerinin** ne olduğu ile
ayrışır. Priority magnitüde, recent-K zamana bakar; bu yüzden ikisi tamamlayıcıdır.

| Sınıf | Adet (holdout/transfer) | Beklenen | Priority | Recent-K |
| --- | --- | --- | --- | --- |
| `P_win` | 5 / 2 | `procedure` | ✅ `procedure` | ✖ `none` |
| `R_win` | 5 / 2 | `procedure` | ✖ `none` | ✅ `procedure` |
| `BOTH` | 6 / 2 | `procedure` | ✅ | ✅ |
| `NONE` | 3 / 2 | `none` | ✅ `none` | ✅ `none` |
| `NEG` | 3 / 0 | `avoidance` | ✅ `avoidance` | ✅ `avoidance` |
| `FAIL` | 2 / 0 | `none` | ✅ `none` | ✅ `none` |

- `P_win`: üç bağımsız pozitif **en yüksek magnitüde** ama **en eski**; en yeni
  epizotlar düşük magnitüdlü korelasyonlu kopyalardır → priority prosedürü
  kurtarır, recent-K kurtaramaz.
- `R_win`: bağımsız pozitifler **en yeni** ama düşük magnitüde; yüksek magnitüdlü
  eski epizotlar korelasyonlu kopyalardır → recent-K kurtarır, priority kurtaramaz.
- `NONE`/`FAIL`: `MIN_GROUP_SIZE` altında bağımsız destek veya tutarlılık
  `CONSISTENCY_MIN` altında → hiçbir kol aday üretemez (fail-closed).
- `NEG`: üç bağımsız negatif kaynak → `avoidance`, asla çalıştırılabilir pozitif
  prosedür değil.

Kategori dağılımı **simetriktir** (`P_win` = `R_win` = 5+2, `BOTH` iki kolda
eşit doğru). Bu yüzden birincil fark tam olarak sıfırdır ve aralık anlamlı etkiyi
(0) içerir: tasarım gereği **kazanç iddia edilmez**.

## 3. Ön-kayıtla uyum

- §2: birincil karşılaştırma A2−A1; A0 ikincil referanstır, tek başına replay
  etkisi sayılmaz.
- §3: birim görev/bağımsız kaynak ailesidir; korelasyonlu kopyalar
  (`sourceGroup` paylaşan epizotlar) tek kaynak sayılır ve `countIndependentSources`
  ile ölçülür.
- §4: iki kol da aynı `groupForCandidates`/`groupForRecentCandidates` kapısını,
  aynı `MIN_GROUP_SIZE=3` ve `CONSISTENCY_MIN=0.8` kapılarını kullanır; replay
  `registered:false`, `authority:'CANDIDATE_ONLY'` kalır, `promotionInput` null.
- §5: kontrat dondurulmuş (seed 3310, 2000 tekrar, 0.95, `minimumSamples` 24,
  `minimumTransfer` 8, `wrongWriteTolerance` 0); bootstrap aile düzeyinde paired.
- §6: sonuçlar bu dosyaya değil, ayrı rapor + JSON'a yazıldı; `assertsGain=false`.

## 4. Öğrenilen nesnenin somut sürümü

M3 replay hattı `registered:false`, `CANDIDATE_ONLY` ve `authority:'CANDIDATE_ONLY'`
taşır; otomatik terfi yoktur. Öğrenilen nesne tipi `procedure` (`replace_text`)
veya `avoidance`dır.

- Her aday `support` (bağımsız destek epizot kimlikleri), `counterexamples`,
  `nIndependent`, `consistency` ve `sourceRefs` taşır.
- Aday → parent/version → kaynak → qualification → operatör/promotion kararı
  zinciri canlı yolda `lib/cli-replay.js` + `lib/experience/learning-intake.js`
  + `lib/experience/compiler.js` üzerinden kurulur (PR #4332/#4338/#4366/#4367).
- Canlı kabul kontrolü (`--promotion-approval` + `--promotion-capability`)
  PR #4354 ile bağlandı; authority-backed fiş, tüketim kaydı ve outcome hash'i
  bağlar.

**Üretim varsayılanı değişmez:** cognition opt-in kalır (`opts.cognition.replay`).

## 5. Kapsam ve iddia sınırı

- `assertsGain = false`; bu belge bir varsayılan/terfi iddiası kurmaz (§9).
- Ölçüm geçerlidir (`status: MEASURED`) ve seçim yüzeyinin doğru çalıştığını
  gösterir; **H1 deneyini koşmaz** ve G3 kapanışı sayılmaz.
- Korpus donmuş bir fikstürdür; sayılar seed'e bağlı deterministiktir, makine
  hızına göre değişen alan yoktur (test: iki koşu byte-identical).
- Kalan G3 gereksinimleri (bileşim/çıkarma kolları, değişen ortam, restart,
  eski beceri non-inferiority, güç ve maliyet) hâlâ `NOT_MEASURED`; bu belge
  onları kapatmaz.

## 6. G3 aktarım ve eski beceri durumu

Ön-kayıt §6 ve plan §7 gereği G3 kapanış kapısı ayrı kalır:

| Gereksinim | Durum |
| --- | --- |
| M3 H1 deneyi (adayların holdout görevlerine uygulanması) | `NOT_RUN` — kilitli corpus/split manifesti + paired adapter gerekir |
| Bileşim kolu (mevcut + seçilmiş COG) | `NOT_MEASURED` |
| Tek-tek çıkarma karşılaştırmaları | `NOT_MEASURED` |
| Değişmiş ortama uyum süresi | `NOT_MEASURED` |
| Restart sonrası kabul edilmiş hash kullanımı | kod merge (PR #4354), ölçülmedi |
| Eski beceri non-inferiority probe | `NOT_MEASURED` |
| Güç hesabı ve maliyet ölçümü | `NOT_MEASURED` |

Bu bölüm, `cog-m3-b4-replay-status-20261029.md` §3 tablosunu günceller; G3
kapanış kapısı (#4060) hâlâ açıktır ve bu belge onu kapatmaz.
