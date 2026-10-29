# M3/B4 replay deney durumu ve G3 aktarım raporu

**Ön-kayıt:** `docs/task-packs/cog-m3-replay-preregistration-20261027.md` (KİLİTLİ).
**Kaynak SHA:** `1f3907de2e482fdb76122d0019106bd0c77d33fe` (main, dirty: false).
**İlgili iş:** [#4069](https://github.com/ali-ulu/huqan/issues/4069), epic [#4060](https://github.com/ali-ulu/huqan/issues/4060).
**Tarih:** 2026-10-29. Durum: `NOT_RUN`.

## 1. B4 Lab sonucu

### 1.1 Mevcut B4 (learned-procedure-transfer)

Mevcut B4 deneyi (`test/cognitive-lab-b4-transfer.test.js`, 10/10 geçti)
`lib/cognitive-lab-b4-evaluator.js` üzerinden koştu.

| Corpus | Durum | Gerekçe | A0 | A1 | A2 | O | A2 wrong-write |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v1 (diagnostic) | MEASURED | seen-data fit, §17 saymaz | 13 | 13 | 21 | 24 | 0 |
| v2 (confirmatory) | **REJECT** | `candidate_wrong_write` | 13 | 13 | 19 | 24 | 1 |

v2 sonucu: `primary.mean = 6/24`, `primary.interval = [-1/24, 13/24]`,
`clearsEffect = false`. Guard olmadan bile güven aralığı sıfırı temizlemez.
Yanlış yazma koruması `protected-prose` türünde bir görevde tetiklendi.

### 1.2 M3'e özgü B4 (priority vs recent-K)

Ön-kayıt §6: "Şu anda çalıştırıcı, bağımsız corpus/split manifesti ve bunların
hash'leri bu teslimde üretilmedi."

Mevcut altyapı:

- `lib/cognition/replay-priority.js::selectReplay` — PER öncelikli seçim.
- `lib/cognition/replay-generalize.js::selectRecent` — `at desc, episodeId asc`
  sıralı recent-K seçim.
- `lib/cli-replay.js::runReplayComparison` — aynı journal üzerinde priority ve
  recent-K kollarını ortak kaynak doğrulama, bağımsız destek, derleme ve
  qualification kapılarıyla çalıştırır. `{ priority, recent }` döndürür.
- `lib/cognitive-lab-b4-evaluator.js::evaluate` — paired bootstrap contract.

Eksik olan:

1. M3 B4 için kilitli corpus (gerçek görevlerden türetilen bağımsız örnekler,
   source/qualification/holdout ayrımı, oracle çalıştırıcı).
2. Her iki kolun tam Coder runtime üzerinden yürütülmesi (dry-run ötesinde).
3. Corpus digest ve split manifest hash'lerinin ayrı imzalı commit ile
   kilitlenmesi (ön-kayıt §6).

**Etiket: NOT_RUN.** Ön-kayıt §6 açıkça "Bu ön-kayıt bunlar olmadan deney
başlatma veya kazanım raporlama izni değildir" der.

## 2. Öğrenilen nesnenin somut sürümü

M3 replay hattı `registered: false`, `CANDIDATE_ONLY` ve `authority: CANDIDATE_ONLY`
taşır. Otomatik terfi yoktur.

Öğrenilen nesne tipi: `procedure` (replace_text).

Somut sürüm bilgisi:
- `parentVersion: 0` (ilk aday sürümü).
- `compiledSupport`: en çok 33 bağımsız kaynak (1 birincil + en çok 32 baseline).
- `sourceHashes`: her kaynağın `readSealedRun().sourceHash` değeri.
- `proposalHash`: `buildLearningProposal` çıktısı.
- `qualification`: mevcut `compiler.js::qualify` üzerinden geçti.

Canlı kabul kontrolü (`--promotion-approval` + `--promotion-capability`):
PR #4354 ile eklendi. Authority-backed fiş, tüketim kaydı, outcome ve fiş
hash'i bağlar. Eski terfi yeni fişi durdurur.

**Üretim varsayılanı değişmez:** cognition opt-in kalır.

## 3. G3 transfer ve eski beceri etkisi

G3 program kapanış kapısı (`docs/cognitive-architecture-plan.md` §7):

> Kollar: mevcut HUQAN; seçilmiş COG bileşimi; etkin bileşenlerin
> bağımlılıklarını koruyan tek-tek çıkarma karşılaştırmaları.

G3 gereksinimleri:

| Gereksinim | Durum |
| --- | --- |
| Bileşim kolu (mevcut + seçilmiş COG) | NOT_MEASURED |
| Tek-tek çıkarma karşılaştırmaları | NOT_MEASURED |
| Değişmiş ortama uyum süresi | NOT_MEASURED |
| Restart sonrası kabul edilmiş hash kullanımı | PR #4354 kodu merge edildi, ölçülmedi |
| Eski beceri non-inferiority probe | NOT_MEASURED |
| Güç hesabı | NOT_MEASURED |
| Maliyet ölçümü (wall time, process sayıları) | NOT_MEASURED |

M7/G1 holdout sonucu ZARAR olarak raporlandı
(`docs/task-packs/cog-m7-g1-holdout-result-20261028.md`). Bu sonuç G3'ün
birleşik sistem ölçümünün parçasıdır ama G3'ü kapatmaz.

## 4. Test durumu

Kaynak `1f3907de` üzerinde koşan testler:

| Dosya | Sonuç |
| --- | --- |
| `test/cognitive-lab-b4-transfer.test.js` | 10/10 |
| `test/cognitive-lab-b4-experiment.test.js` | 8/8 |
| `test/cognition-replay-priority.test.js` | 10/10 |
| `test/cognition-replay-generalize.test.js` | 8/8 |
| `test/cli-replay-dry-run.test.js` | 14/14 |
| `test/cognition-replay-promotion-runtime.test.js` | 30/30 |
| `test/cognitive-lab-b4-cli-wiring.test.js` | 4/4 |

Toplam: 84/84 geçti. CI (GitHub Actions) main'de yeşil.

## 5. Kapsam ve iddia sınırı

Bu rapor mevcut durumu belgelemekten öteye geçmez. M3'e özgü B4 deneyi
koşulmadı; G3 bileşim ve çıkarma kolları ölçülmedi. Ön-kayıt §6'daki eksik
maddeler tamamlanmadan deney başlatma veya kazanım raporlama yetkisi yoktur.

**Üretim varsayılanı değişmez:** hiçbir etiket üretim varsayılanını
kendiliğinden değiştirmez; cognition opt-in kalır.
