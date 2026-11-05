# R51 — HUQAN anlam modeli ön-kaydı

Kapsam: #3583 PR1, offline öğretmen çıktıları ve eğitim verisi sözleşmesi.
R50'nin donmuş corpus, canonical JSON ve pair digest sözleşmesi yeniden kullanılır.
Bu belge model çıktıları ve D holdout ölçümü görülmeden kaydedilir.

## Veri ve öğretmenler

Etiket sırası `CONTRADICTION`, `ENTAILMENT`, `NEUTRAL`, `ABSTAIN`.
Öğretmen adapter çıktısı `{teacherId, teacherVersion, input, distribution, latencyMs}`.
Her çift için en az iki farklı öğretmen kimliği gerekir. Olasılıklar sonlu,
[0,1] aralığında ve toplamı 1 olmalıdır (tolerans 1e-6).
Soft label, öğretmen dağılımlarının aritmetik ortalamasıdır.
Ortalama total-variation uzaklığı 0.25'i aşarsa örnek insan incelemesine gider;
inceleme tamamlanmadan eğitim ağırlığı sıfırdır. Diğer ağırlık `1-disagreement`.
Öğretmen kimlikleri bağımsızlık kanıtı değildir; gerçek kaynak ve sürümler veri
provenance'ında açıklanır. Test girdileri gerçek öğretmen çalışması sayılmaz.

Lisans allowlist'i CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, MIT ve Apache-2.0.
Kaynak URL, attribution ve lisans kaydı zorunludur; bu kayıt tek başına
lisansın gerçekliğini kanıtlamaz. İçe alınan veri kaynak belgesiyle doğrulanır.
[SNLI kaynak sayfası](https://nlp.stanford.edu/projects/snli/) CC-BY-SA-4.0
belirtir. Dataset lisansı ile yükleme script'inin lisansı ayrı değerlendirilir.
Kaynak veriler ve öğretmen kayıtları offline girdidir; runtime'a öğretmen
adapter'ı veya dataset yükleyicisi eklenmez.

## Sızıntı ve tekrar üretim

CLI holdout otoritesini kullanıcı dosyasından değil, repodaki R50 corpus'tan
okur. Holdout içerik digest'i, ters çevrilmiş çift ve aynı pairGroupId eğitim
ve kalibrasyondan dışlanır. Öğretmen çıktısı yalnız bilinen çiftlerle join edilir.
Dataset canonical JSON ile yazılır, kaynak commit ve holdout digest'i taşır;
aynı girdiler ve aynı commit aynı byte'ları üretmelidir. Mevcut çıktı ezilmez.
R50 holdout etiketleri PR5 final ölçümüne kadar eğitim/tuning girdisi değildir.

## Donmuş bütçe ve promotion

Seed 3583; artifact en fazla 10 MiB. Tek claim çifti inference CPU p95 en fazla
5 ms (ısınma sonrası 1000 çift; makine ve Node sürümü raporlanır).
Aile karşılaştırması aynı veri, split, seed, readout ve eğitim bütçesiyle yapılır.
Calibration yalnız calibration split'te; aile seçimi holdout'ta yapılmaz.

PR5'te D vs B birincil karşılaştırmadır: paired Brier iyileşmesinin %95 güven
aralığı alt sınırı >0, nokta iyileşmesi >=0.01; ECE bozulması <=0.02;
FPR artışı <=0.02; non-abstain coverage >=0.10. Aynı holdout üzerinde D vs C
ve kuralların sinyal vermediği altküme ayrıca raporlanır. R50'nin sample
adequacy ve bağımsız adjudication kapıları korunur. Yetersiz destek veya
başarısız eşik varsayılanı `shadow` bırakır; başarı PR5'te `on` açar.
Model sinyali otomatik reject/block yetkisi taşımaz; kesin kuralları ezemez.

## Kabul durumu

PR1 bitmiş sayılması için gerçek lisanslı dataset ve öğretmen girdisiyle CLI
artifact'i, replay, holdout sızıntı negatif testi ve kalite kapıları gerekir.
Bu sözleşme tek başına veri toplandığını, model eğitildiğini veya kazanım
sağlandığını kanıtlamaz. PR2-PR5 ve canlı ürün bağlantısı tamamlanmadan R51 kapanmaz.

### PR1 gözlenen veri hattı

SNLI train başlangıcından 100 kayıt kaynak/lisans bilgisiyle kaydedildi.
Dataset gold etiketi bir öğretmendir; ikinci kaynak, gold alanı gösterilmeden
claim metinlerini değerlendiren offline LLM öğretmenidir. Bu küçük İngilizce
örneklem Türkçe performans veya model kazanımı kanıtı değildir.
Gerçek export: 76 train / 24 calibration, 10 örnek inceleme bekler ve ağırlığı
sıfırdır. `training-dataset.json` digest'i
`sha256:70fc216858bd5005cc278992ffa04f1848e0f669a154d6054d0b8470ab7c5188`.
Öğretmen sürümü annotation içeriğinin canonical digest'iyle sabittir;
model kimliği açıklanmadığı için model sürümü doğrulanmış sayılmaz.
Kaynak snapshot digest'i ve annotation yöntemi independent-teacher provenance
alanındadır. Test artifact'i gerçek iki girdiden yeniden üretip karşılaştırır.
Güncel main `8ef3d0e0` tabanında yeni dört offline script,
classified-unreachable toplamını 204'ten ölçülen 208'e çıkarır;
runtime reachable kümesine öğretmen bağımlılığı eklenmez.

### Amendment 1 (2026-11-05): holdout v2 — yeni datasetVersion, tek değerlendirme

Bu ek, holdout v2 üzerinde herhangi bir tahmin hesaplanmadan önce kaydedilir. Push edilen commit'in zamanı kayıttır.
Yukarıdaki satırlar değişmez; eşikler değişmez.

**Neden.** R50 holdout'u 13 skorlanabilir çift (5 pozitif) taşır; Brier güven aralığı bu boyutta anlamlı değildir.
`contradiction-eval-v1` donmuş kalır. Yeni holdout, R50 §3'ün "yeni dataset ancak yeni `datasetVersion` ve yeni ön-kayıtla doğar"
kuralına göre ayrı bir sürüm olarak eklenir; `contradiction-eval-v1` holdout'unun yerine geçmez.

**Dataset.**

| Alan | Değer |
|---|---|
| datasetVersion | `contradiction-holdout-v2` |
| sha256 (LF baytları) | `16d31ea2c92a88a10798eddd84b7cb1db65fe63c5a0404f5c032493f1e610d75` |
| dosya | `train/laya-v2/holdout_v2/holdout_v2.jsonl`, repo `huqan-decision-engine` commit `b21fc9e` (yerel; henüz push edilmedi) |
| çift sayısı | 371: 200 CONTRADICTION / 171 NOT_CONTRADICTION; 196 Türkçe / 175 İngilizce |
| seed | 3584 |
| yazar | `mistral-small3.2:24b` |
| etiket paneli | `llama3.1:8b`, `phi4:14b`, `granite3.3:8b`; etiket = panel çoğunluğu, yazarın niyeti çoğunlukla aynı değilse çift atılır (471 üretilen, 96 atıldı, 371 kaldı; 283'ü oybirliği) |
| öğretmen zinciri ile ilişki | Yazar ve panel ailelerinin hiçbiri laya-v2 öğretmen zincirinde (`qwen3.8`, `nemotron-3.5-bolt`, `openjev`) yok |
| örtüşme | laya-v2 öğretmen train/calibration/test, üretilen tüm öğretmen çiftleri ve R50 ile ayrık (birebir iddia ve token-Jaccard >= 0.8 kontrol edildi) |

Dosyayı değerlendirenin baytları bu sha256 ile eşleşmelidir; eşleşmiyorsa değerlendirme durur.

**Adjudication: `MODEL_PANEL`.** Etiketler model panelinin çoğunluğudur; bağımsız bir insan gözden geçiren
tarafından doğrulanmamıştır. R50 `provenance.adjudication` alanı `ADJUDICATED` **değildir** ve bu ek onu o değere getirmez.
Bu yüzden promotion kapısı, sonuç ne olursa olsun, bağımsız insan incelemesi tamamlanana kadar **kapalı** kalır (R50 §3, §12, §14).
Bu holdout'tan çıkan sayılar `shadow` kararını `on`a çevirmek için kullanılamaz; yalnız hazırlık kanıtıdır.

**Karşılaştırma.** D = laya-v2, seçilmiş **seed 1**, HUQAN tek-sıcaklık kalibrasyonu (T = 1.45) uygulanmış olasılık.
Seed, HUQAN calibration üzerindeki kalibre Brier ile önceden seçilmiştir; holdout v2 seçime katılmaz.
Baseline = R50 §12 **B kolu**: `runContradictionRules` kuralları, `score = max(declared confidence)`, calibration split'te fit edilmiş donmuş
score→P(contradiction) eşlemesi (artifact digest `ae922532c617d70f65593331b7e129745e992969fd62eee7e289dcb2e03d9f37`,
`contradiction-eval-v1` calibration split'inden yeniden üretilir ve bu digest ile doğrulanır). Holdout v2 çiftlerinde
kurallara yalnız iddia metni verilir (subject/relation/sourceType/frameId yoktur); `Stored claim:` satırı stored, `Incoming claim:` satırı incoming'dir.

**Eşikler (değişmez, R50 §5 ve R51 "Donmuş bütçe ve promotion").** Karar eşiği 0.5. Skorlanabilir çift >= 10. Her biri D vs B, aynı 371 çift üzerinde:

1. paired Brier iyileşmesinin (B Brier − D Brier) %95 güven aralığı alt sınırı > 0 **ve** nokta iyileşmesi >= 0.01;
2. ECE bozulması (D ECE − B ECE) <= 0.02;
3. FPR artışı (D FPR − B FPR) <= 0.02;
4. non-abstain coverage >= 0.10; coverage, R50 §12 ile aynı tanımla eşikte pozitif denen çiftlerin oranıdır (D için raporlanır). Modelin cevap verdiği çift oranı ayrıca raporlanır.

Paired bootstrap: seeded, çift başına Brier farkı, 10000 yeniden örnekleme, iki yönlü %95 yüzdelik aralık, seed 3583 (numpy `default_rng`).
ECE: 10 eşit genişlikli kutu, kutu ağırlıklı |ortalama olasılık − pozitif oranı| (laya-v2 `eval/r50` tanımıyla aynı); iki kolda aynı fonksiyon.
Türkçe ve İngilizce alt kümeleri ek olarak, kapı kararı vermeden raporlanır.

**Değerlendirme kuralları.**

- Seed 1 holdout v2 üzerinde **bir kez** değerlendirilir. Seed 0 değerlendirilmez. Sıcaklık, eşik, seed veya başka hiçbir parametre holdout v2'ye bakılarak seçilmez, ayarlanmaz, yeniden kalibre edilmez.
- Yalnız teknik bir hata (metrik üretilmeden çökme) yeniden koşuyu haklı kılar; bu durumda sonuç raporunda belirtilir.
- Sonuç ne olursa olsun yayınlanır; kapı eşiği geçilmese de, geçilse de aynı şekilde raporlanır.
- Bağımsız insan incelemesi herhangi bir etiketi değiştirirse ölçüm yeniden çalıştırılır ve bu bölümün sayıları geçersiz olur.
