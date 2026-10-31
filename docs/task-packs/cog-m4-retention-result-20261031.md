# M4 unutma (retention) H1: kontrollü Lab sonucu

İlgili iş: [#4070](https://github.com/ali-ulu/huqan/issues/4070) (epic [#4060](https://github.com/ali-ulu/huqan/issues/4060)).
Ön-kayıt: [`cog-m4-retention-preregistration-20261031.md`](cog-m4-retention-preregistration-20261031.md) (main `8daea6f6`).
Kod: `lib/cognitive-lab-m4-{corpus,episode,runner,evaluator}.js`, `bin/huqan-cognitive-lab.js m4`.
Durum: **kontrollü sentetik fikstür sonucu**; üretim kazanımı veya varsayılan terfi iddiası değildir. `assertsGain:false`, `intelligenceGain:NOT_MEASURED`.

Bu belge ön-kayıt metnini değiştirmez. Sonuç, ön-kayıt dondurulduktan sonra tek seferlik bir koşudan alınmıştır ve yalnız bu corpus/seed için geçerlidir.

## 1. Koşu

```bash
node bin/huqan-cognitive-lab.js m4 --m4-workdir <temp-dir>
```

- Corpus: seed `40701`; `calibration=32`, `holdout=32` grup (grup = `sourceGroup`).
- Ölçüm referans anı corpus sabitidir (`now=2026-10-31T00:00:00.000Z`), `Date.now()` değil; aynı corpus her koşuda aynı raporu verir.
- Her grup taze bir Kernel memory store'a tohumlanır: 5 "gerekli" kayıt (önem 0.9, yaş 10 gün, kullanım 5) ve 4 "önemsiz" kayıt (önem 0.05, yaş 400 gün, kullanım 0). Her 8. grup ayrıca hem gerekli hem unutulabilir bir "risk" kaydı taşır (önem 0.05, yaş 120 gün); bu, hatırlamanın düşebileceği tek mekanizmadır.
- Her iki kol da gerçek yoldan geçer: `MemoryLifecycle.consolidate` → `lib/memory-consolidation.js` seçici → `MemoryLifecycle.archive` (fişli, zincirli). Kollar: `candidate` = `retention.enabled:true`; `control` = `retention` yok (varsayılan yalnız-`superseded` seçici, burada hiçbir şey seçmez).
- Ölçüm: arşiv sonrası varsayılan okuma kümesi boyutu ve held-out sorgularda `recall@3`. Sonra her arşivlenen kayıt `restore` ile geri yüklenir; dönmeyen kayıt `REJECT`'tir.
- Bütçe aynıdır; iki kol aynı corpus ve sorgu setini görür.

## 2. Donmuş manifest

| Alan | Değer |
| --- | --- |
| `corpusDigest` | `57795cd85c9e7075fc010e6c01d75b13a4332e4a43156a516d28a0672bbd560a` |
| `groupDigest` | `fed49243f89785d21aba302a299a47eedc1e84239c4ce56e12267a9ad381d492` |
| `preregistrationDigest` | `b3de08208ac5befaf8bac055001332d6f620c127b0e63b9d82cb92d74904285d` |
| `sigma` (calibration, 32 grup) | `0.056002` |
| `nRequired` | `24` (= taban `max(24, ceil(...))`) |
| Eşli kontrat | `seeded-paired-bootstrap`, seed `40701`, 2000 resample, %95 |

Manifest holdout açılmadan `wx` ile yazıldı; aynı iş dizininde ikinci koşu `M4_MANIFEST_EXISTS` ile reddedilir.

## 3. Sonuç

**Etiket: `GAIN`** — `pairedGroups=32` (≥ `nRequired=24`), bütünlük ihlali yok (`firewallBypass=0`, `approvalBypass=0`), geri alınamayan mutasyon yok.

| Ölçü | Delta | Ortalama | %95 CI |
| --- | --- | --- | --- |
| recall@3 (yüksek iyi) | `candidate − control` | `−0.020833` | `[−0.041667, −0.005208]` |
| Okuma kümesi küçülmesi (`shrink`) | `control − candidate` | `+4.125` (toplam 132) | — |
| Geri yükleme gereken (yanlış unutulan) arşiv oranı | `neededArchived / archived` | `0.030303` | limit `0.05` (aşılmadı) |

Yorum: Bu corpus'ta retention politikası, varsayılan okuma kümesini grup başına ~4.1 kayıt küçültürken held-out recall@3'ü non-inferior sınır içinde tuttu (CI alt sınırı `−0.0417 > −0.05`). Kayıp, yalnız risk kaydı taşıyan gruplardan gelir (yanlış unutulan 4 kayıt / 132 arşiv = `0.030303`); bu oran `RESTORE_RATE_MAX` altındadır ve her kayıt geri yüklenebilirdir.

## 4. İddia sınırı

- Corpus **sentetiktir**: "önemsiz" kayıtlar kasten yaşlı ve düşük önemdedir. Sonuç, ön-kayıtlı hattın (corpus → manifest → gerçek consolidate/archive → eşli değerlendirme) uçtan uca çalıştığını gösterir; **üretimde unutma kazanımı kanıtı değildir**.
- `assertsGain` bu sonuçla `true` olmaz. Varsayılan/terfi kararı, gerçek ve bağımsız bir kohort ile G3 birleşik kabulü sonrası ayrı bir PR'da değerlendirilir (ön-kayıt §7, §10).
- Retention modülü sinyal/öneri düzeyindedir: firewall, onay ve reflective-promotion son sözü tutar. Arşiv fişlidir ve geri alınabilir; `dryRun` varsayılanı değişmez.

## 5. Tekrar üretim

- Aynı seed ve split boyutlarıyla koşu deterministiktir (saat/rastgelelik yok; manifest/report `wx`).
- Sonuç JSON'u: [`fixtures/cognitive-lab/m4-retention-result-20261031.json`](../../fixtures/cognitive-lab/m4-retention-result-20261031.json).
- Testler: `node --test test/cognition-m4-lab.test.js test/cognition-m4-episode.test.js`.

## 6. Sonraki adımlar

1. Gerçek/bağımsız bir M4 kohortu (izleme probelerinden ayrı, ön-kayıtlı) ile ölçümü tekrarlamak.
2. G3 birleşik kabulünde maliyet/gecikme ve eski beceri non-inferiority'sini raporlamak.
3. Ancak bundan sonra `opts.retention` varsayılanı ayrı PR'da değerlendirilebilir.
