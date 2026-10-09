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

_(ölçümden sonra eklenir)_
