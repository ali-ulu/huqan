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
`sha256:943a44d8aec141c3cc019997eec874c725423aadd911f0e0b099c01f69512af6`.
Öğretmen sürümü annotation içeriğinin canonical digest'iyle sabittir;
model kimliği açıklanmadığı için model sürümü doğrulanmış sayılmaz.
Kaynak snapshot digest'i ve annotation yöntemi independent-teacher provenance
alanındadır. Test artifact'i gerçek iki girdiden yeniden üretip karşılaştırır.
Güncel main `8ef3d0e0` tabanında yeni dört offline script,
classified-unreachable toplamını 204'ten ölçülen 208'e çıkarır;
runtime reachable kümesine öğretmen bağımlılığı eklenmez.
