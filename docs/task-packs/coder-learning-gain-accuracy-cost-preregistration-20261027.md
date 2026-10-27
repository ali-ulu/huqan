# Coder öğrenme kazanımı — doğruluk ve toplam maliyet ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Külliyat (§4), metrikler (§6) ve eşikler (§7) 27 Ekim 2026'da ölçüm koşulmadan önce yazıldı ve bu commit ile donduruldu. Ölçüm koşuldu; sonuç §12'dedir.
**Base:** `d4b82a72` (origin/main), issue [#4341](https://github.com/ali-ulu/huqan/issues/4341).
**Biçim referansı:** B4 ön-kaydı ([`docs/task-packs/b4-transfer-preregistration-20261004.md`](b4-transfer-preregistration-20261004.md)).
**Reuse:** `test/coder-learning-gain.test.js` paired kol deseni (baseline/learned, `cli.js` gerçek giriş noktası), `lib/coder/journal-store.js`, `.huqan/coder/candidates` candidate dosyası.

## 0. Amaç ve sınır

#4341 iddiasını ölçer: HUQAN Coder, önceki doğru ve hatalı davranışlardan öğrendiğinde sonraki benzer görevlerde **doğruluk kaybetmeden** ve **toplam maliyeti düşürerek** iyileşir.

Sınırlar:
- Bu, mevcut davranışın **ölçümüdür**; runtime kod değişikliği yoktur. Değişen dosyalar yalnızca bu ön-kayıt belgesi, eval testi ve onun raporudur.
- Metin tabanlı (`--adapt-memory`) aynı-yöntem aktarım ölçümüdür. Genel öğrenme başarısı iddiası tek başına yapılmaz (#4341 kabul kriteri 5).
- CPU maliyeti ölçülemezse `NOT_MEASURED` raporlanır (bkz. §7).

## 1. Hipotezler

- **H0:** Eşit bütçede, learned kol holdout görevlerinde baseline kola göre doğrulukta iyileşme **ve** toplam maliyette (wall time) anlamlı azalma göstermez.
- **H1 (yönlü, higher-is-better doğruluk / lower-is-better maliyet):** Learned kol, (a) holdout doğruluğunu baseline ile eşit tutar (yanlış yazma 0), (b) paired her görevde daha az doğrulama process'i kullanır, (c) eğitim maliyeti dahil **amortize toplam wall time** baseline holdout toplamının altında kalır.

## 2. Gerçeklik sınırı

Ölçüm, `cli.js coder <task> --synthesize / --adapt-memory` gerçek üretim giriş noktası üzerinden yapılır; görevler gerçek geçici Git depolarında koşar. Bu bir öğrenme-kazanımı iddiasını dar külliyatla sınırlar: **aynı yöntem ailesi** (`arithmetic-expression`, `replace_text` görevleri). Farklı-yöntem aktarımı yalnızca kontrol (anti-vaka) olarak raporlanır; ondan genel transfer iddiası çıkarılmaz.

## 3. Kollar ve eşit bütçe

| Öğe | Tanım |
|---|---|
| Baseline kol | Taze çalışma kökü; holdout görevleri `--synthesize` ile. |
| Learned kol | Aynı fixture'lar; eğitim görevi `--synthesize` + `rememberFile` ile koşulur, sonra holdout görevleri `--adapt-memory` ile. |
| Eşit bütçe | Her iki kol `BUDGET = 8` process limiti (test içi `CONTRACT.budget`); aynı görev hash'leri, aynı kaynak içerik, aynı test komutları. |

## 4. Külliyat (ölçümden önce kilitlendi)

- **Eğitim:** 1 görev (`parity`, `x -> x + 1`, `rememberFile` ile). Yalnızca learned kol koşar.
- **Holdout (paired, N = 5):** `first/second/third/fourth/fifth` — farklı parametre adları (`fresh`, `value`, `item`, `seed`, `count`) ve farklı örnek/check aralıkları; hepsi aynı `arithmetic-expression` ailesi. Eğitimde ve yöntem seçiminde **kullanılmaz**.
- **Dağılım kayması (rapor amaçlı):** holdout'ta parametre adı ve değer aralıklarının değişmesi zaten hafif bir shift'tir; sert shift, farklı-yöntem kontrolüne bırakılır.
- **Farklı-yöntem kontrolü (anti-vaka):** `novel` görevi (`x -> x*x + 1` ailesi dışı). Learned kol bellek adayını reddetmeli (`needs_human_decision` + rollback), baseline taze sentezle başarıya ulaşmalı; otomatik fallback olmamalıdır.
- **Önceki beceri non-inferiority:** farklı-yöntem kontrolünden **sonra**, learned kola yeni bir aynı-aile görevi (`regression`) verilir; learned kolun process tasarrufu kalıcı olmalıdır (öğrenme sonraki genişleme ile eski beceriyi bozmamalı).
- **Restart:** her CLI çağrısı ayrı process'tir; eğitim bitiminden sonra açılan journal store yeniden açılır ve manifest girdileri (`learningEligibility`) kalıcılığı gösterilir. Training source/candidate dosya hash'leri tüm koşum sonunda korunur.
- **Hash:** her görevin `taskHash` ve `testHash`'i (sha256) eval raporunda görev başına raporlanır; baseline ve learned kollar arasında birebir eşitliği test assert eder.

## 5. Split ve leakage

Holdout görevleri eğitim koşusuna giren herhangi bir içerikle üretilmez; eğitim görevi ile holdout görevleri ayrık kaynak dosyalar kullanır. Sınıf (iii) candidate-aleyhi vaka, farklı-yöntem kontrolü (learned kolun reddi) ile temsil edilir; bu vaka yokluğu §8'de verdict etkisi yaratır.

## 6. Metrikler ve yön

| Sıra | Metrik | Kollar | Yön | Rol |
|---|---|---|---|---|
| 1 | Doğruluk (holdout): `outcome=applied_tested` + `observedVerification.ok` + kaynak içerik beklenenle birebir eşit | paired | higher-is-better | H1a |
| 2 | Yanlış yazma sayısı (holdout + kontrol + non-inferiority) | learned | = 0 | REJECT eşiği |
| 3 | Toplam wall time (holdout, eğitim dahil amortize) | baseline − (learned + eğitim) | lower-is-better | H1c |
| 4 | Doğrulama process sayısı (görev başına) | paired | lower-is-better | ikincil |
| 5 | Attempt/rollback/tekrar-denetim sayıları | rapor | — | şeffaflık |
| 6 | CPU maliyeti | — | — | `NOT_MEASURED` |

## 7. Ön-kayıtlı eşikler (ölçümden önce kilitlendi; eval testinde `CONTRACT` olarak da sabittir)

- `holdoutSize` = 5 (altında `INSUFFICIENT`).
- `wrongWriteTolerance` = 0 → tek yanlış yazma `REJECT`.
- `perTaskProcessGain` = 5/5 holdout görevinde `learnedProcesses < baselineProcesses` (deterministik kapı; bir görevde bozulursa o metrik `INSUFFICIENT`).
- `amortizedWallGain` = `baselineHoldoutWallMs - learnedHoldoutWallMs - trainingWallMs > 0`. Ölçüm tek makinede paired koşulur; bu eşiği geçmezse maliyet metni `INSUFFICIENT` raporlanır, doğruluk/metin kapıları etkilenmez.
- `minimumSamples` = 5; anti-vaka sınıfı (farklı-yöntem kontrolü + non-inferiority) eksikse ölçüm `INSUFFICIENT`.
- Zaman ölçümü `process.hrtime.bigint()` ile yapılır; CI'daki zaman iddiası tek koşum gözlemidir (yanıltıcı olmaması için eşik eşik-raporu olarak değerlendirilir, CI assertion'ı olarak değil).

## 8. Fail-closed ve örnek yeterliliği

- Veri yok/yetersiz → `INSUFFICIENT`; ölçülemeyen boyut → `NOT_MEASURED`.
- Leakage, kollar arası bütçe farkı, görev hash eşitsizliği, `NaN/Infinity`, learned kolda yanlış yazma → `REJECT`.
- Bu küçük külliyat güç analizi değildir; aralık dar, genelleme sınırlıdır. Daha büyük tekrar aynı donmuş protokolle yapılabilir.

## 9. Kill / durdurma kriterleri

- Learned kol holdout doğruluğunu baseline'ın altına düşürürse (doğruluk regresyonu) → `REJECT`.
- Farklı-yöntem kontrolünde otomatik fallback veya bellek sızması → `REJECT`.
- Aynı koşumun tekrarında deterministik sonuçlar (outcome/process sayıları) değişirse → `INSUFFICIENT`.

## 10. Kabul komutları

```sh
node scripts/run-tests.js test/coder-learning-gain.test.js test/coder-composition-learning-gain.test.js test/coder-learning-gain-accuracy-cost.test.js
```

Rapor, eval testinin `t.diagnostic` JSON çıktısıdır: külliyat digest'leri, kol metrikleri, amortizasyon ve anti-vaka sonuçları tek kayıtta.

## 11. Kapsam dışı (bilinçli)

- B4 tarzı evaluator mutant matrisi (bu deneyin kontratında yok).
- Yeni receipt/wire/release; production wiring; `intelligenceGain` sınıfı genel iddia.
- Görsel/SuP veya dış taraf çıktısı.

## 12. Sonuç

İki koşum yapıldı; §4–§7'ye (külliyat, metrikler, eşikler) dokunulmadı. Koşum 1, arka planda eşzamanlı graphify dizinlemesiyle koştu (duyarlilik nedeni: wall time CPU yüküne duyarlıdır); koşum 2, makine boşken tek test olarak koşuldu ve **birincil ölçüm** kabul edildi. Deterministik çıktılar (process sayıları, outcome, görev hash'leri) iki koşumda birebir aynıydı; yalnızca wall time değerleri yükle duyarlı olarak değişti (rapor amaçlı, assertion değil).

**Koşum 2 (birincil) sonuçları:**

- **Doğruluk (H1a): TUTTU.** 5/5 holdout görevinde her iki kol `applied_tested`, `observedVerification.ok=true`, kaynak içerik baseline ile learned arasında birebir eşit; learned kol yanlış yazma 0 (`REJECT` eşik tetiklenmedi). Görev başına `taskHash`/`testHash` (sha256) eşitliği eval assert edildi.
- **Process (ikincil):** her holdout görevinde baseline 4 → learned 1; toplam 20 → 5, `rememberFile` ile kaydedilen prosedürle **amortize +11 process tasarrufu**. `perTaskProcessGain` 5/5.
- **Toplam maliyet (H1c): EŞİK GEÇMEDİ → INSUFFICIENT.** Holdout wall time baseline 11.479 ms vs learned 9.522 ms (tasarruf 1.957 ms), eğitim 2.906 ms → amortize kazanç **-949 ms** (≈ %8 negatif). N = 5 külliyatında eğitim maliyeti başabaşa ulaşmıyor (brüt tahmin: ~8–9 holdout görevi). Fail-closed kuralı gereği maliyet iddiası raporlanmaz; doğruluk ve metin kapıları etkilenmez.
- **CPU maliyeti: NOT_MEASURED** (çocuk-proses CPU örneklemesi yeni bağımlılık gerektirir; §0'da bildirildi).
- **Farklı-yöntem kontrolü (anti-vaka): beklenen gibi.** `novel` (`x*x + 1`) görevinde learned kol bellek adayını reddetti (`needs_human_decision`), deneme geri alındı, kaynak dosya değişmedi, otomatik fallback yok; baseline taze sentezle başarıya ulaştı.
- **Önceki beceri non-inferiority: tutuldu.** Anti-vakadan sonra `regression` görevinde learned kol kayıtlı parity prosedürünü yeniden oynadı (baseline 4 vs learned 1 process).
- **Restart/persist: tutuldu.** Journal store yeniden açıldı; `learningEligibility` manifest girdileri (`positive_procedure` / `negative_example`) ve eğitim kaynağı + candidate dosya hash'leri korundu.
- **Kapsam beyanı:** Bu, dar bir aynı-yöntem (arithmetic/parity) sentetik külliyatın paired ölçümüdür; genel öğrenme-kazanımı iddiası yapılmaz (#4341 kabul kriteri 5). Tam ölçüm kaydı (JSON), eval testinin `t.diagnostic` çıktısıdır: `test/coder-learning-gain-accuracy-cost.test.js`.

**Verdict özeti:** `accuracy=MEASURED/gain`, `processGain=11`, `amortizedWallGain=INSUFFICIENT`, `cpuCost=NOT_MEASURED`, `wrongWrites=0`, anti-vaka ve non-inferiority kapıları geçti.
