# M10 merak yönlendiricisi H1: kontrollü Lab sonucu

İlgili iş: [#4071](https://github.com/ali-ulu/huqan/issues/4071) (epic [#4060](https://github.com/ali-ulu/huqan/issues/4060)).
Ön-kayıt: [`cog-m10-curiosity-preregistration-20261030.md`](cog-m10-curiosity-preregistration-20261030.md) (main `f63e698a`).
Kod: `lib/cognitive-lab-m10-{corpus,episode,runner,evaluator}.js`, `bin/huqan-cognitive-lab.js m10`.
Durum: **kontrollü sentetik fikstür sonucu**; üretim kazanımı veya varsayılan terfi iddiası değildir. `assertsGain:false`, `intelligenceGain:NOT_MEASURED`.

Bu belge ön-kayıt metnini değiştirmez. Sonuç, ön-kayıt dondurulduktan sonra tek seferlik bir koşudan alınmıştır ve yalnız bu corpus/seed için geçerlidir.

## 1. Koşu

```bash
node bin/huqan-cognitive-lab.js m10 --m10-workdir <temp-dir>
```

- Corpus: seed `40710`; `monitor=8`, `calibration=16`, `holdout=256` grup (grup = kaynak grubu × görev ailesi).
- İzleme probe'u: `probeSetId=m10-monitor-p1`, `frameRef=frame-m10-v1`; predictor sürümleri `m10-p1` → `m10-p2`.
- Her iki kol da gerçek dream→verify yolundan geçti: Dream loop seçimi (`lib/agent-v3-dream-loop-adapter.js`), doğrulama adımı `lib/agent-step-executor.js` firewall'u + `kernel.verify`. Grup gerçekleri taze bir Kernel graph'ına tohumlandı; yalnız aday havuzu dream sonucu olarak enjekte edildi.
- Kollar: `candidate` = dream adımına top-level `curiosity: true` + izleme geçmişi (`curiosityHistory`) geçirilir; `control` = bayrak kapalı (confidence sırası). Lab episode bu seçeneği `processDreamStep`'e doğrudan verir; `opts.cognition.curiosity` yalnız AgentV3 seam'i için geçerlidir. Aynı bütçe: 3 hipotez/grup, 1 cycle.

## 2. Donmuş manifest

| Alan | Değer |
| --- | --- |
| `corpusDigest` | `359cc9f8d2c9b16f02293f28160152f57e4482c0caac5895db6ebd07a79562ac` |
| `groupDigest` | `9baba8c9ffd97536dc980ad5e7ec05d391ab05e67a6bb44fecb188a5eccfa6e9` |
| `monitoringProbeDigest` | `fea3485f00877c6e3554538ba19569825080b3ff0bcc6a20b09e07df08079c5b` |
| `preregistrationDigest` | `5aafb98cfb66168276bbfe9af927d848e55d4ff26335332d266e4f94dd23cd31` |
| `sigma` (calibration, 16 grup) | `0.272166` |
| `nRequired` | `233` |
| Eşli kontrat | `seeded-paired-bootstrap`, seed `40710`, 2000 resample, %95 |

Manifest holdout açılmadan `wx` ile yazıldı; aynı iş dizininde ikinci koşu `M10_MANIFEST_EXISTS` ile reddedilir.

## 3. Sonuç

**Etiket: `GAIN`** — `pairedGroups=256` (≥ `nRequired=233`), bütünlük ihlali yok (`firewallBypass=0`, `approvalBypass=0`), engellenen adım `0`.

| Ölçü | Delta | Ortalama | %95 CI |
| --- | --- | --- | --- |
| Tahmin hatası (MAE, düşük iyi) | `control − candidate` | `+0.038143` | `[+0.020025, +0.056220]` |
| Görev başarısı (doğrulanan, yüksek iyi) | `candidate − control` | `+0.167969` | `[+0.132812, +0.204427]` |
| Seçilen zorluk kayması | `candidate − control` | `−0.004119` | limit `−0.05` (aşılmadı) |

Yorum: Bu corpus'ta merak sıralaması, confidence sırasına göre hem doğrulanan hipotez oranını hem de tahmin hatasını iyileştirdi; seçim daha kolay görevlere kaymadı. `benzer` bölgesinin gürültü guard'ı izleme geçmişinde `noiseGuard=true` üretir; bu, düz/gürültülü bölgenin terfi ettirilmediğini gösterir.

## 4. İddia sınırı

- Corpus **sentetiktir**: `yapabilir` bölgesindeki doğrulama olasılığı kasten daha yüksektir. Sonuç, ön-kayıtlı hattın (corpus → manifest → gerçek yürütme → eşli değerlendirme) uçtan uca çalıştığını gösterir; **üretimde öğrenme kazanımı kanıtı değildir**.
- `assertsGain` bu sonuçla `true` olmaz. Varsayılan/terfi kararı, gerçek ve bağımsız bir kohort ile G3 birleşik kabulü sonrası ayrı bir PR'da değerlendirilir (ön-kayıt §7, §10).
- İzleme probe'ları nihai holdout'tan kaynak-grubu düzeyinde ayrıdır; holdout etiketleri ranker/history/eşik/model seçimine girmez (ön-kayıt §4 negatif testleri PR-5 testlerinde: `cognition-m10-lab.test.js` oracle izolasyonu ve `monitoring_history_contains_holdout` REJECT testi).

## 5. Tekrar üretim

- Aynı seed ve split boyutlarıyla koşu deterministiktir (saat/rastgelelik yok; manifest/report `wx`).
- Sonuç JSON'u: [`fixtures/cognitive-lab/m10-curiosity-result-20261030.json`](../../fixtures/cognitive-lab/m10-curiosity-result-20261030.json).
- Testler: `node --test test/cognition-m10-lab.test.js test/cognition-m10-episode.test.js`.

## 6. Sonraki adımlar

1. Gerçek/bağımsız bir M10 kohortu (izleme probelerinden ayrı, ön-kayıtlı) ile ölçümü tekrarlamak.
2. G3 birleşik kabulünde maliyet/gecikme ve eski beceri non-inferiority'sini raporlamak.
3. Ancak bundan sonra `opts.cognition.curiosity` varsayılanı ayrı PR'da değerlendirilebilir.
