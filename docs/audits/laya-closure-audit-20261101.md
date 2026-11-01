# COG-D — Laya kapanış denetimi

> Durum: ölçüm ve karar kaydı. Bu belge mevcut Laya denemesinin resmi sonucunu
> huqan runtime sözleşmesine bağlar ve **STAY_SHADOW** kararını açık kaydeder.
> Yeni eğitim, model indirme ve runtime davranış değişikliği bu teslimde yoktur.
> İlgili iş: COG-D [#4394](https://github.com/ali-ulu/huqan/issues/4394);
> üst plan [#4390](https://github.com/ali-ulu/huqan/issues/4390).

- Denetim tabanı (huqan): `main @ 7a4bdf2a` (2026-11-01)
- Denetlenen deneme deposu: `ali-ulu/huqan-decision-engine @ af8b953cbcb649e4ddef97456315d78c2f66281e`
- Denetlenen deneme yolu: `train/laya-v1/` (README + `manifest.json` + `results/`)
- İlgili huqan sözleşmeleri: `plugins/laya-risk.js`, `docs/laya-risk-plugin.md`,
  `docs/core-plugin-boundary-contract.md`, `docs/task-packs/semantic-model-preregistration-r51.md`,
  `docs/task-packs/semantic-model-result-r51.md`, `lib/semantic-model-port.js`

Bu belge bir kayıttır: yazıldığı gün doğru olanı bildirir, ürünün bugünkü durumu
hakkında iddia değildir (`scripts/check-docs-drift.js` RECORD_PATHS).

## 1. Ne denetlendi ve neden

Plan D, Laya kapanış denetimini ilk alt adım olarak tanımlar: checkpoint/revision/hash,
kalibrasyon, recall/FPR, bağımsız veri, ONNX/Node eşdeğerliği ve runtime kural uyumu.
Denetimin amacı, **resmi sonucu doğrulamak ve kararı huqan runtime kuralına bağlamak**;
başarı bekleyerek işi uzatmak değildir. Denetim başarısızsa STAY_SHADOW açık yazılır ve
eğitimi başarılı ilan etmek için kapı gevşetilmez.

Denetim iki ayrı "Laya" yüzeyini ayırır:

| Yüzey | Nerede | Bu denetimde rolü |
|---|---|---|
| Laya-v1 **eğitim denemesi** | `huqan-decision-engine/train/laya-v1` | Denetlenen model; sonucu STAY_SHADOW |
| Laya **risk köprüsü** | `plugins/laya-risk.js` + `lib/laya-mcp-client.js` | Runtime kural uyumu denetlenen mevcut yüzey |

## 2. Checkpoint, revision ve hash

| Öğe | Değer | Kaynak |
|---|---|---|
| Base model | `convaiinnovations/laya-multilingual` (mmBERT-base, 322M) | `train/laya-v1/README.md` |
| Base lisans | Apache-2.0 (base model MIT) | `train/laya-v1/README.md` |
| Eğitim aracı | `laya-train` 0.4.14, tek Colab T4, fp16, 3 epoch, ~90 dk | `train/laya-v1/README.md` |
| Checkpoint | `model.safetensors` sha256 `352b5c50…c4c9e88` (644 MB) | `train/laya-v1/README.md` |
| Checkpoint konumu | Özel Kaggle dataset `huqanulu/laya-v1-ckpt`; git'te **yok** | `train/laya-v1/README.md` |
| Train manifest | 13.500 → 13.100 train + 400 calib; sha256 `1e77b6b8…2ae8` | `train/laya-v1/manifest.json` |
| Eval manifest | 1.800 (test split); sha256 `06b01706…1353` | `train/laya-v1/manifest.json` |
| Seed | 0 | `manifest.json`, `rl_agent_config.json` |

**Bulgu (checkpoint bütünlüğü):** Ağırlık dosyası git'te değil (644 MB) ve denetim
ortamından hash **yeniden hesaplanamadı**; README'nin verdiği `352b5c50…c4c9e88`
kısaltması tek başına bağımsız bütünlük kanıtı değildir. Bu, huqan `NOT_YET_WIRED`
kuralının dışında kalan bir kanıt boşluğudur: model zaten `shadow` modundadır ve
terfi için ayrı bir R51 ölçümü gerekir, dolayısıyla bu boşluk runtime'ı etkilemez.

## 3. Bağımsız yeniden hesaplama (R50 çiftleri)

README §2'nin 92 çiftlik ve 13 çiftlik holdout sayıları, `results/r50_ft.json` ve
`results/r50_base.json` ham olasılıklarından **denetimde sıfırdan yeniden hesaplandı**
(eşik 0.5, pozitif sınıf `CONTRADICTION`):

| Küme | n | accuracy | precision | recall | FPR | Brier |
|---|---|---|---|---|---|---|
| base, tüm 92 | 92 | 0.6848 | 0.525 | 0.969 | 0.467 | 0.2365 |
| laya-v1, tüm 92 | 92 | **0.8261** | 0.767 | 0.719 | **0.1167** | **0.1769** |
| base, holdout 13 | 13 | 0.9231 | 0.833 | 1.000 | 0.125 | 0.1277 |
| laya-v1, holdout 13 | 13 | 0.9231 | 0.833 | 1.000 | 0.125 | 0.1441 |

Yeniden hesaplanan değerler README §2 ile birebir uyuşur (yuvarlama toleransı içinde).
Holdout ECE, README'deki 10-bin tanımıyla yeniden hesaplandı: **0.2895** — README §3 ile
aynı. Bu, denetlenen sayıların kopya olmadığını, ham veriden türetilebildiğini gösterir.

## 4. Kalibrasyon

| Öğe | Değer | Not |
|---|---|---|
| Fitted temperatures | choice 2.60, noul 4.46, score 2.19 | `rl_agent_config.json` |
| score kalibrasyon örneklem | 20 | laya-train `issues: ["fitted on only 20 calibration items"]` |
| Held-out bev-decision ECE | 0.3066 → **0.0496** | `train_report.json` |
| Abstention (10% hedef hata) | `choice:2`, `score:3-5` eşiği 1.0 → her zaman abstain | README §1 |

**Bulgu (kalibrasyon taşınabilirliği):** Sıcaklıklar bev-decision üzerinde fit edilmiştir,
HUQAN çiftleri üzerinde değil. Bu yüzden bev-decision ECE iyileşmesi (0.05) huqan R50
holdout ECE'sine (0.2895) taşınmaz. Kalibrasyon kaynağı ile ölçüm kaynağı ayrıdır; bu
ayrım plan D'nin "sızıntı denetimi" şartıyla uyumludur.

## 5. Bağımsız veri ve lisans

| Öğe | Durum |
|---|---|
| Eğitim verisi kaynağı | `avbiswas/bev-decision` (276.188 satır, 502.570 soru) |
| Veri lisansı | **Bilinmiyor** (karışık upstream) — `audit/FINDINGS.md` |
| İnsan/ikinci yargıç | Jev 1.14 (1.279/2.450 yanıt) ve Kev-4B (2.450/2.450) — `audit/FINDINGS.md` |
| Sızıntı denetimi | `laya-train` train/eval 0 overlap bildirdi; manifest sha256 sabit |
| R50 holdout | 13 çift, bağımsız adjudication **PENDING** — `semantic-model-result-r51.md` |

**Bulgu (lisans):** bev-decision lisansı bilinmiyor; R51 ön-kaydı lisans allowlist'ini
(CC0/CC-BY/CC-BY-SA/MIT/Apache-2.0) zorunlu kılar. Bu, modelin üretime alınmasını
başlı başına engelleyen bir bulgudur ve denetimde açık kaydedilir. Denetim sırasında
yeni veri indirilmedi, yeni eğitim yapılmadı.

## 6. ONNX / Node eşdeğerliği

**Durum: yapılmadı (FEASIBILITY_BLOCKED).** README §4'ün kaydı:

> `@receptron/laya` 0.2.0 `[CLS]/[SEP]/[MASK]/[PAD]` token'larını sabit kodlar; mmBERT
> tokenizer'ında bunlar yok. Multilingual yol `laya-ts` (export → `encoder.onnx` +
> `head.onnx`) ya da bir yama gerektirir.

Denetim ortamında `@receptron/laya` bağımlılığı yok (`package.json`'da yok) ve ONNX
artefaktı üretilmemiş; Node paritesi ölçülemedi. Plan D'ye göre ONNX export tek başına
kabul değildir; **parite ölçülmeden model runtime'a alınmaz.** Bu, STAY_SHADOW kararını
pekiştiren ikinci bağımsız engeldir.

## 7. Runtime kural uyumu (mevcut risk köprüsü)

`plugins/laya-risk.js` mevcut Laya yüzeyidir ve huqan kuralına uyar:

- **Sinyal üreticisi, karar otoritesi değil.** `gateSignal` yalnız sinyal döndürür;
  `lib/gate-signal-provider.js::mostRestrictive` kararı `block > dry_run_only > review >
  allow` sırasıyla **yalnız yükseltir**. `gateSignal` temiz `allow` için `undefined`
  döndürür, yani izin üretmez.
- **Fail-closed.** Yanlış paket hash'i, erişilemeyen sidecar, timeout, aşırı çıktı,
  sonlu olmayan `noul`/`score` yanıtı → okuma yok; hiçbir mod düşük-risk okumasına
  çevrilmez (`docs/laya-risk-plugin.md`, `test/laya-risk.test.js` 25/25 geçiyor).
- **Duygu firewall girdisi değil.** Köprü bir risk sınıflandırıcısıdır; appraisal etiketi
  veya duygu durumu taşımaz.

## 8. Karar

| Kapı (R51 ön-kayıt) | Ölçülen | Durum |
|---|---|---|
| Holdout destek tabanı (>= 10) | 13 | geçti |
| Non-abstain coverage >= 0.10 | 0.000 | **başarısız** |
| Paired Brier CI alt sınırı > 0 | ölçülemedi | **başarısız** |
| Brier nokta iyileşmesi >= 0.01 (D vs B) | 0.097 (13 çift, CI yok) | geçti (zayıf destek) |
| ECE bozulması <= 0.02 | +0.251 | **başarısız** |
| FPR artışı <= 0.02 | +0.125 | **başarısız** |
| Holdout adjudication ADJUDICATED | PENDING | **başarısız** |

**Verdict: `STAY_SHADOW`.** `lib/semantic-model-port.js::DEFAULT_MODE` `shadow` kalır.
Ölçüm kapıları (`docs/task-packs/semantic-model-result-r51.md`) değiştirilmedi; hiçbir
eşik gevşetilmedi.

### 8.1 C şemasına bağlama kararı

Plan D: "Laya'nın mevcut BEV göreviyle appraisal uyumu ölçülmeden etiket alanı eklenmez.
Yeni 0.8B paralel eğitim hattı açılmaz."

- Laya-v1 **BEV çelişki tespiti** için eğitilmiştir; appraisal/duygu etiketi görevi yoktur.
  Appraisal uyumu ölçülmediği için C şemasına (`conversation-turn`) **etiket alanı
  eklenmedi**.
- Tek öğrenci hattı kararı: mevcut Laya-v1 hattı (mmBERT-base + `laya-train`) tek hattır.
  Yeni 0.8B paralel hat **açılmadı**; Qwen3.5-4B/9B öğretmen karşılaştırması bu denetimin
  kapsamı dışındadır ve veri/lisans kapısı açılmadan başlatılmaz.
- C ile bağlama, yalnız bir **sinyal** olarak ve opt-in kalır; conversation yüzeyi
  Laya'dan gelen hiçbir alanı yetki veya ödül girdisi olarak tüketmez (C değişmezi 4/5).

## 9. Sonraki kapı

1. **ONNX/Node paritesi** (`laya-ts` export + `results/r50_ft.json`'a karşı parite testi) —
   E #4395'in önkoşulu.
2. **bev-decision lisansı** netleşmeden hiçbir yeni eğitim başlatılmaz.
3. **Daha büyük, bağımsız adjudike edilmiş HUQAN holdout'u** — R51 kapısı 13 çiftle geçemez.
4. HUQAN R50 train+calibration (79 çift) üzerinde yeniden kalibrasyon ve holdout yeniden
   skorlaması.

Bu adımlar D'nin kalan işidir; bu denetim onları başlatmaz, yalnız sıralarını kaydeder.
