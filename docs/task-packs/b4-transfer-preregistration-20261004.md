# B4 — Learned procedure transfer ön-kaydı (preregistration)

**Status:** protokol ölçümden önce kilitlendi. Görev ailesi (§3), eşikler (§7) ve dağılım (§8) 4 Ekim 2026'da maintainer tarafından onaylandı. Ölçüm koşuldu; sonuç §16'dadır. Gain iddiası yoktur.
**Base:** `6850fe9c` (main), package `0.13.2`.
**Issue:** [#3310](https://github.com/ali-ulu/huqan/issues/3310), program [#3306](https://github.com/ali-ulu/huqan/issues/3306). Öncül: kaynak admission kabul matrisi #3445, kalıcı kayıt şartı #3443; biçim referansı B6 ön-kaydı (#3444/#3446).
**Reuse:** `lib/coder/apply-derivation.js` (public giriş), `lib/experience/coder-routing-runtime.js` (learned route), `lib/coder/journal-store.js`, `lib/experience/budgeted-journal.js` (deterministik bütçe saati), `lib/cognitive-lab-manifest.js` (`computeManifestDigest`), B6'nın paired bootstrap / `lockContract` deseni (`test/cognitive-lab-b6-scheduler.test.js`).

## 0. Amaç ve sınır

Bu belge, opt-in learned coder caller'ının (#3364) mühürlü bir kaynak koşudan öğrendiği prosedürü **daha önce görülmemiş ortamlara** doğru biçimde aktarıp aktaramadığını ölçen **B4** deneyinin, deney başlamadan önce kilitlenmesi gereken sözleşmesidir.

Sınırlar:
- Bu bir **gain iddiası değil**, ölçüm protokolüdür. Sonuç ne çıkarsa `NOT_MEASURED` / `INSUFFICIENT` / `REJECT` / sayısal verdict olarak, olduğu gibi raporlanır.
- Otomatik prosedür üretimi (induction), foundation training, self-install, yeni receipt/wire/release yoktur.
- `intelligenceGain` bu deneyle tek başına `MEASURED` olmaz; §2 ve §10'daki koşullar sağlanmadıkça `NOT_MEASURED` kalır.

## 1. Hipotez ve nedensel iddia

- **H0:** Aynı mühürlü deneyime sahip iki kol arasında — learned route (qualification + trust + coverage kapıları) ile naif tekrar (kapısız) — görülmemiş ortamlarda doğru-sonuç oranında anlamlı fark yoktur.
- **H1 (yönlü):** Learned route, naif tekrara göre doğru-sonuç oranını **anlamlı** artırır (§7) **ve** yanlış yazma sayısı **0**'dır (güven regresyonu yok).

Yön tek taraflıdır (higher-is-better).

## 2. Gerçeklik sınırı — kazanç nerede ölçülebilir

Mevcut caller tam tanımlı `replace_text` görevi alır: `find`/`replace` görevde zaten vardır. Bu durumda öğrenmesiz deterministik coder ile learned route aynı işlemi uygular; belirsiz ve kaymış hedefleri ikisi de aynı biçimde reddeder. 4 Ekim pilotu bunu gösterdi: 20 yeni bağlamda baseline 20/20, candidate 20/20, fark 0. **Tam tanımlı görevde fark yapı gereği sıfırdır.**

Bu yüzden B4 külliyesi **eksik tanımlı görev** ailesidir (§3): görev yalnız hedef yolu ve capability niyetini bildirir, `find`/`replace` metnini vermez. Bu ailede:

- Öğrenmesiz coder (A0) işlemi kuramaz ve uygulanabilir her görevi kaçırır. A0'a karşı kazanç **yapı gereğidir**; bu nedenle A0 karşılaştırması ikincil metriktir ve tek başına kazanç sayılmaz.
- Asıl soru deneyimin **nasıl** kullanıldığıdır. Birincil karşılaştırma aynı deneyimi kapısız uygulayan naif tekrar koluna (A1) karşıdır. Ölçülen şey ezber değil, öğrenilmiş qualification/trust kapılarının görülmemiş ortamda doğru uygulamayı yanlıştan ayırma değeridir.

## 3. Deney birimleri ve arms

| Öğe | Tanım |
|---|---|
| Görev | Donmuş bir çalışma ağacı + hedef yol + capability niyeti + beklenen sonuç (`change` ya da `refuse`) + kaynak koşu kimlikleri. `find`/`replace` görevde **yoktur**. |
| A0 — baseline | Deneyim yok. Eksik tanımlı görevi deterministik coder'a verir; işlem kurulamazsa ret. |
| A1 — naif tekrar (ablation) | Aynı mühürlü kaynak koşudan işlem metnini okur ve qualification, trust, coverage ve canary kapılarını atlayarak uygular. Path-safety ve tek-uygulama sınırı aynıdır. |
| A2 — candidate | `task.experience` ile learned route: mühürlü kaynak → qualification → trust replay → coverage → PEM routing → kalıcı kayıt şartı (#3443) → yazma. |
| O — oracle (tavan, arm değil) | Tam tanımlı görevle deterministik coder. Ulaşılabilir doğru-sonuç tavanını raporlar; karşılaştırmaya girmez. |
| Eşit bütçe | Her kol görev başına tek dispatch; aynı kaynak SQLite snapshot'ının ayrı kopyası; aynı deterministik bütçe saati; aynı dosya ağacı. Journal olay sayısı ve yazma maliyeti kol başına ayrı raporlanır. |

## 4. Görev külliyatı (donmuş, hash'li)

- **Biçim:** her görev bir JSON kaydıdır: `taskId`, `split`, `sourceRunIds`, `capabilityId`, `targetPath`, `tree` (dosya yolu → içerik), `expected` (`change` + beklenen içerik | `refuse`), `class` (aşağıda), `familyMatrix`.
- **Doğru sonuç yüklemi:** `expected = change` ise hedef dosya beklenen içeriğe birebir eşitse ve başka dosya değişmediyse doğrudur. `expected = refuse` ise hiçbir dosya değişmediyse doğrudur. Bunların dışındaki her disk etkisi **yanlış yazmadır**.
- **Sınıflar (çeşitlilik zorunlu):**
  - (i) **Uygulanabilir:** yeni ağaç, hedefte kaynak metin tam bir kez geçer → `change`.
  - (ii) **Kapı-anlamlı anti-vaka:** belirsiz hedef (birden çok geçiş), kaymış hedef (metin yok), sonraki koşuda başarısız olup güveni düşmüş kaynak, başka workspace kaynağı → `refuse`. Naif tekrarın burada yanlış yazması beklenir.
  - (iii) **Candidate aleyhine vaka:** learned route'un yanlış reddettiği veya ikisinin de ayırt edemediği durumlar. Örnek: yetersiz güven geçmişi nedeniyle `medium` risk katmanında ret; metin bir kez geçiyor ama anlam olarak yanlış bağlamda (`expected = refuse`).
  Sınıf (iii) yoksa ölçüm tek yönlü/rigged sayılır ve verdict `INSUFFICIENT` olur.
- **Körlük:** görevler aile × sınıf matrisinden deterministik seed ile üretilir, elle seçilmez; üretici hangi kolun lehine olduğunu hesaplamaz.
- **Hash:** `fixture.digest = computeManifestDigest(tasks)`; külliye deneyden önce commit'lenir ve değiştirilemez.

## 5. Split, görülmemiş ortam ve leakage

- `train`: kaynak koşuların üretildiği ağaçlar ve sözleşme kontrolü.
- `holdout` (primer): **yeni çalışma kökleri**, aynı hedef yol, kaynakta hiç görülmemiş çevre içerik ve dosya kümesi.
- `transfer` (ikincil): **farklı hedef yol** veya farklı workspace. Mevcut prosedür yola bağlıdır (`source_procedure_mismatch`). Candidate'ın burada reddetmesi beklenir ve bu sonuç olduğu gibi raporlanır. Yol genellemesi bu deneyin kapsamı dışındadır.
- Kaynak koşu kimlikleri ve ağaç içerikleri splitler arasında ayrıktır. Holdout/transfer içeriği kaynak koşu üretimine sızarsa sonuç `REJECT` olur.

## 6. Metrikler ve yön

| Sıra | Metrik | Kollar | Yön | Rol |
|---|---|---|---|---|
| Primer | doğru-sonuç oranı (holdout) | A2 − A1, paired | higher-is-better | H1 |
| Güven | yanlış yazma sayısı | A2 | = 0 | REJECT eşiği |
| İkincil | doğru-sonuç oranı (holdout) | A2 − A0, paired | higher-is-better | yapı gereği; tek başına kazanç değil |
| İkincil | oracle geri kazanımı | A2 / O | higher-is-better | tavana uzaklık |
| İkincil | transfer doğru-sonuç oranı | A2, A1 | rapor | yol sınırının görünürlüğü |
| Maliyet | journal olayı ve yazma maliyeti / doğru sonuç | A2 vs A1 | lower-is-better | non-inferiority değil, rapor |

Primer fark görev başına ikilidir (doğru = 1); B6'daki seeded paired bootstrap uygulanır.

## 7. Ön-kayıtlı eşikler (kilitlendi, 4 Ekim 2026)

Değerler ölçümden **önce** kilitlenir; artefakt implementation testindeki `CONTRACT` olur ve bilinmeyen/eksik alan reddedilir:

- `metric` = `correct-outcome-rate`; `direction` = `higher-is-better`.
- `seed` = 3310; `resamples` = 2000; `confidenceLevel` = 0.95.
- `meaningfulEffect` = **0**: yalnız %95 alt sınır 0'ı geçerse üstün sayılır.
- `wrongWriteTolerance` = **0**: A2'de tek yanlış yazma varsa verdict `REJECT` olur.
- `minimumSamples` = **24** holdout görevi (altında `INSUFFICIENT`); transfer en az 8.

## 8. Örnek yeterliliği

- Önerilen külliye: holdout **N = 24** (8 sınıf i, 10 sınıf ii, 6 sınıf iii), transfer **N = 8**, train kaynak koşuları ayrı.
- Bu bir güç analizi değildir; aralık genişliğiyle birlikte okunur. B6'da olduğu gibi küçük bir örnektir. Daha büyük tekrar aynı donmuş artefaktla yapılabilir.
- Determinizm: aynı külliye yeniden koşulduğunda kol başına correctness digest'i aynı olmalıdır.

## 9. Fail-closed ve integrity

- Veri yok/yetersiz → `INSUFFICIENT`; ölçülemeyen boyut → `NOT_MEASURED`.
- Leakage, kollar arası bütçe farkı, bozuk külliye hash'i, NaN/Infinity, A2'de yanlış yazma → `REJECT`.
- **Evaluator mutantları zorunludur** ve kırmızı üretmelidir: yanlış yazmayı doğru sayma, `refuse` beklenen görevde değişikliği yok sayma, split overlap kontrolünü kapatma, bütçe eşitliğini yok sayma, A1'e kapı sızdırma (A1 = A2 olur).

## 10. Kill / durdurma kriterleri (ölçüm öncesi)

Aşağıdakilerden biri olursa deney durdurulur ve `INSUFFICIENT`/`REJECT` raporlanır:
- Külliyede sınıf (iii) yok veya sınıf dağılımı §8'den sapıyor.
- A1 ile A2 holdout'ta her görevde aynı sonucu veriyor (kapılar etkisiz; primer fark tanım gereği 0).
- A2 − A0 farkı dışında hiçbir fark yok. Bu durumda sonuç "capability transfer" olarak raporlanır, `intelligenceGain` `NOT_MEASURED` kalır.
- Aynı kol iki koşuda farklı correctness digest'i veriyor.
- Split leakage.

## 11. Gerekli wiring (implementation dilimi, bu belgede yok)

- **Eksik tanımlı dispatch:** `task.experience.intentOnly === true` olduğunda `operation` yalnız `{ type: 'replace_text', path }` taşıyabilir. Router `find`/`replace`'i mühürlü prosedürden alır; mevcut tüm kapılar aynen çalışır. Varsayılan kapalıdır; tam tanımlı görev ve deneyimsiz coder davranışı değişmez.
- **A1 naif tekrar:** yalnız test harness'ında bulunur (`test/helpers/cognitive-lab-b4-transfer.js`). Üretime girmez.
- **Kabul:** yeni alan için negatif testler (intentOnly olmadan eksik işlem → bugünkü `invalid_experience_operation`; intentOnly + kaynak yok → ret; intentOnly + yanlış yol → `source_procedure_mismatch`), restart/replay ve #3445 matrisinin intentOnly altında aynen geçmesi.

## 12. Açık sorular

1. **Eşikler (§7) ve dağılım (§8):** onaylandı ve kilitlendi.
2. **Sınıf (iii) "anlam olarak yanlış bağlam" vakaları:** bugünkü kapılar bunu ayırt edemez. Vakalar iki kolu da cezalandırır ve bu bilinçli bir tercihtir. Vakalar külliyeden çıkarılırsa ölçüm learned route lehine çarpık olur.
3. **Transfer splitinin primer olmaması:** mevcut prosedür yola bağlı olduğu için transfer primer seçilirse sonuç yapı gereği negatif çıkar. Yol genellemesi ayrı bir ürün kararıdır.

## 13. Kabul komutları (implementation sonrası)

```text
node --test test/cognitive-lab-b4-transfer.test.js test/coder-learned-acceptance-matrix.test.js
node scripts/architecture-snapshot.js --check --base-ref=<fresh-main-sha>
npm run check:cycles && npm run check:module-boundary && npm run check:layers && npm run check:file-size && npm run check:package-closure
```

## 14. Kapsam

- İçinde: bu ön-kayıt, §11 wiring'i (`experience.intentOnly`), harness ve ölçüm testi.
- Dışında: yol/bağlam genellemesi, otomatik prosedür üretimi, yeni authority/receipt, policy/threshold genişletme, release değişikliği, diğer canary/PEM/fallback modüllerinin topluca bağlanması.

## 15. Göz testi

Külliye hash'i ve split kimlikleri kayıtlı; dört kol için bütçe eşit ve birimleri tanımlı; `mechanisms.B4 = ENABLED`, diğerleri `NOT_MEASURED`; primer metrik A2 − A1 doğru-sonuç oranı; A2 yanlış yazmada `REJECT`; holdout içeriğini train'e kopyalayan fixture `REJECT` verir; aynı kol yeniden koşulduğunda correctness digest'i aynı.

## 16. Sonuç (B4, mevcut learned route ile)

Ölçüm kilitli külliye ve sözleşmeyle koşuldu (`test/cognitive-lab-b4-transfer.test.js`, harness `test/helpers/cognitive-lab-b4-transfer.js`). Her kol görev başına tek dispatch harcadı. Aynı koşu iki kez tekrarlandığında sonuçlar birebir aynı çıktı.

| Split | n | A0 doğru | A1 doğru | A2 doğru | O doğru |
|---|---|---|---|---|---|
| **holdout (primer)** | **24** | 13 | 13 | **18** | 24 |
| transfer | 8 | 2 | 6 | 2 | 8 |

| Yanlış yazma (tüm görevler) | A0 | A1 | A2 |
|---|---|---|---|
| sayı | 0 | 13 | **3** |

- **Verdict: `REJECT` (`candidate_wrong_write`), `assertsGain = false`, `intelligenceGain = NOT_MEASURED`.** A2'nin üç yanlış yazmasının üçü de sınıf (iii) "alıntılanmış geçmiş satır" vakasıdır: metin bir kez geçiyor ama değişmemesi gerekiyor, ve mevcut kapılar bağlamı ayırt etmiyor. Deneyimsiz baseline (A0) hiç yanlış yazmadı; bu, A0'a göre gerçek bir güven gerilemesidir.
- **Guard olmasa da kazanç yok:** primer fark A2 − A1 = **+0,208** (5/24), %95 bootstrap aralığı **[−0,042; 0,458]**; alt sınır `meaningfulEffect = 0`'ı geçmiyor. Kapılar belirsiz hedef (3), güveni düşmüş kaynak (3) ve workspace dışı kaynak (2) vakalarında naif tekrarın 8 yanlış yazmasını önledi. Buna karşılık `medium` risk katmanında, yetersiz güven geçmişi nedeniyle 3 doğru değişikliği reddetti.
- **İkincil:** A2 − A0 = +0,208, aynı aralık; oracle geri kazanımı 18/24 = 0,75.
- **Transfer:** prosedür yola bağlı olduğu için A2, farklı yoldaki 6 uygulanabilir görevin hepsini reddetti (`source_procedure_mismatch`). Naif tekrar bu 6 görevi doğru yaptı ama 2 belirsiz vakada yanlış yazdı.
- **Karar:** #3310'un B4 gain kabulü **karşılanmadı**. Bu dürüst bir negatif sonuçtur. Sonucu değiştirebilecek iki ayrı iş var ve ikisi de ürün kararıdır: (1) alıntı veya geçmiş satırı ayırt eden, bağlama duyarlı bir qualification kapısı; (2) yeterli geçmişi olmayan prosedürlerin `medium` risk katmanında nasıl ele alınacağı. Yol genellemesi ayrıca transfer splitini etkiler.
- **Göz testi sapması (§15):** Cognitive Lab manifesti (`mechanisms.B4 = ENABLED`) bu dilimde üretilmedi. Külliye digest'i `computeManifestDigest({ tasks, sourceOperations })` ile hesaplanır ve testte sabitlenir.

## 17. Ek: bağlam kapısı ön-kaydı (kapı yazılmadan önce kilitlendi)

**Karar (maintainer, 4 Ekim 2026):** §16'daki üç yanlış yazmayı hedefleyen bağlam duyarlı bir uygunluk kapısı denenir.

**Sorun:** Kapı §16'daki üç vakaya bakılarak tasarlandı. Aynı v1 holdout ile yeniden ölçülürse sonuç holdout'a uydurulmuş olur ve kazanç yapay görünür (§5'in leakage yasağı). Bu nedenle:

1. **Kapı kuralı (değişmez):** Learned route — tam tanımlı ve `intentOnly` dispatch — hedef dosyada metnin tek geçişi
   - (a) ilk boşluk dışı karakteri `>` olan bir markdown alıntı satırındaysa, ya da
   - (b) ` ``` ` ile açılıp kapanan bir kod bloğunun içindeyse
   yazmadan `protected_context` ile reddeder. Tırnak içi metin kurala dahil değildir; yapılandırma değerleri meşru olarak değişir. Deneyimsiz deterministik coder (A0, O) değişmez.
2. **Doğrulayıcı külliye v2 (seed 33100):** onaylı sayılar aynıdır (holdout 8 / 10 / 6, transfer 8). Bağlamlar kapıyı iki yönden sınar:
   - sınıf (i): 6 düz uygulanabilir; 1 tırnak içi yapılandırma değeri (`change`); 1 kod bloğunda **güncel** kullanım örneği (`change`; kapı bunu yanlış reddeder).
   - sınıf (iii): 3 `medium` risk; 1 alıntı satırında geçmiş kayıt, 1 kod bloğunda **eski** örnek, 1 düz anlatımda geçmiş kayıt (üçü `refuse`; sonuncusunu kapı göremez).
   - sınıf (ii) ve transfer v1 ile aynı türlerdir. v2 hedef içeriklerinin hiçbiri v1 ile ortak değildir; digest `d63fd30e62e0b9559dc41a042585729579297c0dc65f591ebed4fe95b6a8a575`.
3. **Kapı öncesi v2 referansı (bu ekle birlikte ölçüldü):** A0 13 / A1 13 / A2 18 / O 24 doğru; yanlış yazma A0 0 / A1 13 / A2 3. A2'nin üç yanlış yazması üç korunan bağlam vakasıdır. Verdict `REJECT`.
4. **Karar kuralı:** Doğrulayıcı verdict yalnız v2 üzerinden, §7 sözleşmesi değiştirilmeden verilir. v1'in kapıyla yeniden ölçümü yalnız tanısal olarak raporlanır ve kazanç kanıtı sayılmaz. Kapı kuralı ya da v2 külliyesi, kapı ölçüldükten sonra değiştirilirse sonuç `REJECT` olur.
