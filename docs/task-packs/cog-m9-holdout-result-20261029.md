# M9 değer defteri holdout corpus üreteci: sonuç

İlgili iş: [#4388](https://github.com/ali-ulu/huqan/issues/4388) (epic [#4060](https://github.com/ali-ulu/huqan/issues/4060)).
Ön-kayıt: `docs/task-packs/cog-m9-holdout-preregistration-20261029.md` (kilitli, digest `b9ee6366…`).
Kalibrasyon: `docs/task-packs/cog-m9-holdout-calibration-manifest-20261029.json`.
Rapor: `docs/task-packs/cog-m9-holdout-report-20261029.json`.

## Sonuç: **MEASURED / GAIN** (yalnız H1 kalibrasyon)

| Alan | Değer |
| --- | --- |
| Etiket | **GAIN** |
| Eşli Brier deltası (taban − aday) | `0.09183` |
| %95 GA | `[0.06050, 0.12467]` |
| `meaningfulEffect` | `0` (aralık tamamen üstünde) |
| Kapsam | `195 / 195` (kapsanmayan yok) |
| Aday Brier / ECE | `0.16009` / `0.04591` |
| Taban Brier / ECE | `0.25192` / `0.05569` |
| ECE non-inferiority | `true` (margin `0.05`) |
| `assertsGain` | **`false`** |
| `intelligenceGain` | `NOT_MEASURED` |

**Yorum.** Seçilmemiş holdout kohortunda defterin anahtar-başına `success.p`
tahmini, anahtar-bağımsız taban oranından **anlamlı biçimde daha iyi kalibre**
edilmiştir: eşli Brier farkı sıfırın belirgin üstünde, ECE ise marj içinde
non-inferior. Bu, H1 kalibrasyon iddiasının desteklendiğini söyler.

## Anti-vaka (uniform profil)

Aynı üreteç her anahtarı tek orana (`0.5`) düşürdüğünde anahtar-başına sinyal
kalmaz: ölçüm **`NOT_CLEARED`** ve `gain=false` döner. Ölçüm, sinyal olmayan
yerde kazanç uydurmuyor.

## Kilit ve tekrar üretilebilirlik

| Alan | Değer |
| --- | --- |
| Kaynak SHA | `ee4c4ba6c5f53066f2439121f055c66b6bc8d798` |
| Seed | `20261029` |
| `corpusDigest` | `0ec81a2d72413690b189f1401a7afc3148ac14b2053fc7ed746e9b70a8e6ecfe` |
| Bölmeler | train `240` / calibration `240` / holdout `240` |
| Split denetimi | `CLEAN` (720 karar) |
| `sigma` (calibration, `n−1`) | `0.249242` |
| `requiredSample` | `195` (`powerMet=true`) |
| `MIN_EFFECT` | `0.05` |
| Parmak izleri | corpus `0ec81a2d…`, evaluator `fbe4440c…`, runner `a871904c…`, preregistration `b9ee6366…` |
| Holdout tek-kullanım | `wx` marker; ikinci koşu `M9_HOLDOUT_ALREADY_RUN` |
| Maliyet | `modelCalls 0`, `networkCalls 0`, `coderSteps 0`, `wallMs 739` |

## İddia sınırı (§7)

- Bu bir **kalibrasyon** ölçümüdür; M9 sinyalinin üretim kararıyla ilişkisini,
  G1 gerçek gözlem bağlantısını (#4064/#4065) veya G3 birleşik kabulünü (#4060)
  kanıtlamaz.
- `assertsGain` **`false`** ve `intelligenceGain` **`NOT_MEASURED`** kalır:
  daha iyi kalibrasyon tek başına daha iyi görev başarısı değildir.
- Üretim varsayılanı **değişmedi**; M9 opt-in kalır. Varsayılan yapma kararı ayrı
  bir PR'da, kazanım **ve** G3 kabulü sonrası değerlendirilir.
- Tüketilmiş M7/G1 holdout'u ve sonucu **değişmedi**; bu yeni, bağımsız bir
  kohorttur.

## Yeniden üretme

```bash
node lib/cognitive-lab-m9-holdout.js calibrate /tmp/manifest.json \
  docs/task-packs/cog-m9-holdout-preregistration-20261029.md
node lib/cognitive-lab-m9-holdout.js holdout /tmp/report.json /tmp/manifest.json \
  docs/task-packs/cog-m9-holdout-preregistration-20261029.md
```

Holdout tek kullanımlıktır; yeniden koşmak `M9_HOLDOUT_ALREADY_RUN` ile durur.
