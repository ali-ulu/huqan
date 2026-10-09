# R55 — v2 anlam modeli holdout ölçümü (D kolu)

**Base:** issue [#3717](https://github.com/ali-ulu/huqan/issues/3717), roadmap anahtarı R55.
Protokol ve eşikler `docs/task-packs/semantic-model-preregistration-r51.md` içinde dondu ve
burada **değiştirilmedi**. Veri kuralı eki: `docs/task-packs/semantic-model-data-r55.md`.

## 1. Ön-ilan (ölçümden önce, 2026-10-09)

Bu bölüm R50 holdout'una bakılmadan yazıldı ve ölçüm sonucu ne olursa olsun değişmez.

- **D kolu:** `LOGISTIC_V2` ailesi (R55 PR3b, #3724 ile paketlenen `logistic-v2-tr.json` /
  `logistic-v2-en.json` ve fitted kalibrasyonları), semantic-model port'u üzerinden `shadow`
  modunda, her çift için dil tespitiyle seçilen artifact ve kalibrasyonla. `band: ABSTAIN`
  olan çiftte D çekimser kalır; negatif sayılmaz.
- **Aile seçimi holdout'ta yapılmaz.** v2 ailesi #3717'de önceden belirlendi. v1 aileleri
  (SSM, RWKV, MAMBA, TRANSFORMER) yalnız ikincil, kararsız satırdır.
- **Karar:** R51 PR5'in `decideDefaultMode` fonksiyonu, donmuş eşiklerle (birincil D vs B:
  eşleşmiş Brier iyileşmesinin %95 GA alt sınırı > 0 ve nokta iyileşme ≥ 0.01; ECE bozulması
  ≤ 0.02; FPR artışı ≤ 0.02; çekimser olmayan kapsam ≥ 0.10; R50 örneklem ve bağımsız
  adjudication kapıları). Herhangi bir eşik ölçülemez ya da başarısızsa varsayılan `shadow`
  kalır.
- **Varsayılan aile:** ölçüm sonucu `PROMOTE_ON` olsa bile varsayılan ailenin SSM'den
  LOGISTIC_V2'ye geçişi ayrı, incelenen bir değişikliktir; bu PR yalnız ölçer ve yazar.

## 2. Sonuç

**Karar: STAY_SHADOW.** `DEFAULT_MODE` `shadow`, varsayılan aile SSM olarak kalır.

Komut: `node scripts/semantic-model-holdout-eval.js --source-commit=<sha> --family=LOGISTIC_V2`
(deterministik; iki koşu byte-eşit). R50 kolları aynen yeniden üretildi (B Brier 0.2414).

Holdout: 15 çift, 13 skorlanabilir (5 `CONTRADICTION` / 8 `NOT_CONTRADICTION`; 1
`UNCERTAIN`, 1 `INVALID_PAIR` hariç). Holdout İngilizcedir; tüm çiftler `en` artifact'ına gitti.

| Kol | Karar verilen | TP / FP / TN / FN | FPR | Brier | ECE |
|---|---|---|---|---|---|
| B (kalibre kurallar, R50) | 13 | 0 / 0 / 8 / 5 | 0.000 | 0.2414 | 0.0385 |
| **D (LOGISTIC_V2)** | **2** | **1 / 1 / 0 / 0** | **1.000** | 0.3657* | 0.3578* |
| v1 aileleri (ikincil) | 0 | — | — | — | — |

\* 2 çift üzerinde; ölçüm sayılmaz (`INSUFFICIENT`).

- D 13 çiftin 11'inde `inside_abstain_band` ile çekimser kaldı; kapsam **0.154** (eşik ≥ 0.10 ✓).
- Eşleşmiş D vs B: 2 çift → `INSUFFICIENT` (`sample_below_minimum`); Brier ve ECE ölçülemedi.
- FPR artışı **1.0** (eşik ≤ 0.02 ✗).
- R50 holdout bağımsız adjudication'ı hâlâ beklemede (✗).
- Kuralların sessiz kaldığı 7 çiftte D yalnız 1 karar verdi ve o bir yanlış pozitif.

`decideDefaultMode` gerekçeleri: `paired_brier_not_measured`, `ece_not_measured`,
`fpr_increase_above_0.02`, `holdout_adjudication_not_adjudicated`.

## 3. D'nin emin olduğu iki çift

| Gold | D | Çift |
|---|---|---|
| CONTRADICTION | CONTRADICTION (p=0.87) ✓ | `learning writes to the store` ↔ `learning never writes to the store` |
| NOT_CONTRADICTION | CONTRADICTION (p=0.85) ✗ | `in the enterprise profile the license is commercial` ↔ `in the community profile the license is Apache-2.0` |

Okuma: v2 özellikleri olumsuzluğu (`never`) yakalıyor; ama **kapsam niteleyicisini**
(`enterprise` / `community` profili, `EU` / `US`, `shadow` / `on` aşaması) temsil etmiyor ve
farklı kapsamdaki iki iddiayı çelişki sanabiliyor. Sayısal çelişkilerde (4 ↔ 8 worker, Mart ↔
Ağustos) karar vermiyor, çekimser kalıyor. SNLI'nin fotoğraf altyazısı dağılımından HUQAN'ın kısa,
kapsamlı olgu iddialarına aktarım zayıf.

## 4. Dürüst değerlendirme ve sonraki tur

- SNLI test setinde (eğitimde görülmedi) emin D doğruluğu 0.906 idi (#3724). HUQAN holdout'unda
  aynı model 13 çiftte 2 emin karar verdi ve biri yanlıştı: **alan kayması** gerçek.
- 13 skorlanabilir çift, bir kazancı istatistiksel olarak göstermek için de yetersiz; R50'nin
  bağımsız adjudication kapısı kapanmadan hiçbir sonuç `on` açamaz.
- Sonraki tur için en güçlü kaldıraçlar: (1) HUQAN'ın kendi çelişki inceleme kararları (#3720
  dışa aktarma) ile eğitim; (2) kapsam niteleyicisi ve sayı/birim uyumu için özellikler
  (kurallar zaten `NUMERICAL_CONFLICT` taşıyor — model özelliği olarak girebilir); (3) daha büyük,
  bağımsız denetlenmiş HUQAN holdout'u.
