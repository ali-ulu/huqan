# COG-D — Türkçe yorumlayıcı ön-kaydı (ölçüm öncesi)

İlgili iş: [#4394](https://github.com/ali-ulu/huqan/issues/4394) (COG-D), üst plan
[#4390](https://github.com/ali-ulu/huqan/issues/4390), ana program [#4060](https://github.com/ali-ulu/huqan/issues/4060).
Önkoşul kayıt: `docs/audits/laya-closure-audit-20261101.md` (karar **STAY_SHADOW**, main `5b6c279e`).

Kapsam: COG-D'nin "Türkçe yorumlayıcı distillation" dilimi için **ölçüm öncesi kayıt**. Bu belge
yalnız dokümantasyondur; üretim davranışı, model, eğitim, veri indirme veya ölçülmüş kazanım
iddiası yoktur. §5, §6 ve §8'deki metrik, eşik, örnek birimi ve karar kuralları burada
**sonuç görülmeden** dondurulur; sonradan değiştirilemez (değişiklik yeni bir amendment commit'i
ve gerekçesi ister).

Plan D: *"Sayısal hedefler sonuç açılmadan pilot/power gerekçesiyle dondurulur."* Bu belge o
şartı yerine getirir. Ölçüm kodu, corpus ve koşucu bu PR'da **yoktur**; §6'daki pilot gerekçesi
uygulandıktan sonra ayrı bir PR'da üretilir.

## 1. Bağlam ve devralınan kararlar

- **Laya-v1 kapanış denetimi `STAY_SHADOW`** (`docs/audits/laya-closure-audit-20261101.md`):
  R51 kapıları ECE bozulması (+0.251) ve FPR artışı (+0.125) ile başarısız; holdout 13 çiftle
  kapı geçmez; ONNX/Node paritesi ölçülmedi; `bev-decision` lisansı bilinmiyor.
  `lib/semantic-model-port.js::DEFAULT_MODE` `shadow` kalır. Bu ön-kayıt Laya'yı terfi
  ettirmez ve Laya sonucunu yeniden yorumlamaz.
- **C şemasına etiket alanı eklenmedi** (denetim §8.1): Laya-v1 BEV çelişki tespiti için
  eğitilmiştir; appraisal/duygu görevi yoktur ve uyum ölçülmemiştir. Bu ön-kayıt, C şemasını
  (`conversation-turn`) değiştirmez; yorumlayıcı çıktısı **yalnız sinyal** ve opt-in kalır.
- **Yeni 0.8B paralel eğitim hattı açılmaz** (denetim §8.1). Tek öğrenci hattı kararı korunur;
  bu ön-kayıt mevcut tek hattın (mmBERT-base + `laya-train`) distillation hedefini tanımlar.
- **Duygu çekirdeği eylem yetkisi almaz** (plan değişmezi 4/5). Yorumlayıcı çıktısı
  firewall/risk/trust/onay girdisi olamaz; sabit doğrulama tabanını düşüremez.

## 2. Öğretmen adayları ve seçim gerekçesi

Plan D iki öğretmen adayı adlandırır: `Qwen/Qwen3.5-4B` ve `Qwen/Qwen3.5-9B`. Seçim, aşağıdaki
**donmuş** kriterlerle, insan etiketli sette (§3) yapılır; seçim sonucu açılmadan gerekçelendirilir.

| Kriter | Ağırlık | Kaynak |
| --- | --- | --- |
| Türkçe ironi/alıntı/öfke/sorumluluk sınıflarında sınıf-bazlı F1 | birincil | §3 insan holdout |
| Kalibrasyon (ECE, 10-bin) | birincil | §5 |
| Abstention davranışı (belirsiz → abstain) | birincil | §5 |
| Lisans allowlist uyumu (CC0/CC-BY/CC-BY-SA/MIT/Apache-2.0) | **kapı** | §4 |
| Sabit revision + her dosya hash doğrulaması | **kapı** | §4 |
| CPU bellek ve gecikme bütçesi | ikincil | §7 |

**Kapı kuralı (dondurulmuş):** Lisans allowlist'te değilse veya sabit revision + dosya hash'i
doğrulanamıyorsa aday **elenir**; metrik üstünlüğü bu kapıyı geçemez. Öğretmen seçimi
"en yüksek metrik" değil, "kapıyı geçen adaylar arasında en iyi" kuralıyla yapılır.

**HuggingBay kuralı (dondurulmuş):** HuggingBay yalnız alternatif indirme kaynağıdır. Kaydında
hosted ağırlık bulunması çalışan tam paket kanıtı **değildir**; upstream sabit revision, lisans ve
her dosyanın hash'i doğrulanmadan veri/eğitim girdisi olarak kullanılmaz.

**Öğretmen kopyası yasağı (dondurulmuş):** Değerlendirme döngüsü öğretmenin kendi kopyasıyla
kurulmaz; öğretmen çıktısı ground truth değildir. Ground truth yalnız insan etiketidir (§3).

## 3. Görev seti, etiketler ve bölme

- **Etiket kümesi (dondurulmuş):** `irony`, `quotation`, `anger`, `achievement`, `responsibility`,
  `unknown`. `unknown` bir sınıf değil, **abstention hedefi**dir: kaynak bağı kurulamayan mesaj
  `unknown` etiketiyle işaretlenir ve sayısal kesinliğe çevrilmez (plan A değişmezi).
- **Görev türü:** insan etiketli **Türkçe çok turlu** konuşma parçaları. Tek cümle değil, en az
  iki tur; alıntı/olumsuzlama/ironi belirsizliği korunur.
- **Bölme (dondurulmuş):** konuşma ve kaynak grubu bazında ayrım. Aynı konuşma veya aynı kaynak
  grubundan türeyen parçalar tek bir bölmede kalır. `train` / `calibration` / `holdout` üçlüsü
  ayrıdır; holdout **eğitim ve tuning girdisi değildir**.
- **Holdout ayrılığı:** holdout, §2'deki öğretmen seçimi dahil hiçbir tuning kararına girmez.
  Öğretmen seçimi yalnız `calibration` bölmesinde yapılır; holdout yalnız nihai ölçümde açılır.
- **İnsan adjudication:** holdout etiketleri bağımsız adjudike edilmiş olmalıdır. Adjudication
  `PENDING` iken holdout ölçümü **başarı sayılmaz** (Laya R51 holdout'unun 13 çiftle kapıyı
  geçememesi bu kuralın örneğidir).

## 4. Lisans ve sızıntı denetimi

**Lisans allowlist'i (dondurulmuş):** CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, MIT, Apache-2.0.
Kaynak URL, attribution ve lisans kaydı zorunludur; kayıt tek başına lisansın gerçekliğini
kanıtlamaz. İçe alınan veri kaynak belgesiyle doğrulanır. `bev-decision` lisansı bilinmediği
için (denetim §5) o kaynak bu ön-kayıt kapsamında **kullanılmaz**.

**Sızıntı denetimi (dondurulmuş kapılar):**

1. `train` ∩ `holdout` = ∅ (konuşma ve kaynak grubu düzeyinde; içerik digest'i üzerinden).
2. Aynı konuşma grubunun farklı bölmelere düşmesi yasak (`split_overlap` kapısı).
3. Holdout içerik digest'i ters çevrilmiş/parafraz çiftler için de kontrol edilir.
4. Öğretmen çıktısı yalnız bilinen parçalarla join edilir; holdout parçaları öğretmen
   eğitiminde görünmez.

## 5. Metrikler ve donmuş eşikler

Ölçüm **eşlenmiş (paired)** ve sınıf bazlıdır. Birincil karşılaştırma: **yorumlayıcı kol (D)**
vs **taban kol (B)**.

**Taban kol B (dondurulmuş):** deterministik, kural tabanlı yorumlayıcı (model yok). Sınıf
başına anahtar-kelime/kural seti ve `unknown` eşiği bu ön-kayıtla dondurulur; sonuç görülmeden
değiştirilmez. **Laya-v1 bu etiketler için taban olamaz:** denetim §8.1'e göre Laya'nın
appraisal/duygu görevi yoktur, C şemasına etiket alanı eklenmemiştir ve Laya-v1 BEV çelişki
tespitidir. Bu yüzden B, Laya `shadow` sinyali değil, dondurulmuş deterministik kural tabanıdır.
Laya yalnız §5'in son satırındaki mevcut-görev non-inferiority kapısında referanstır.

| Metrik | Yön | Donmuş eşik |
| --- | --- | --- |
| Sınıf-bazlı F1 (`irony`,`quotation`,`anger`,`achievement`,`responsibility`) | yüksek iyi | her sınıf ≥ taban; macro-F1 farkı paired-bootstrap %95 CA alt sınırı > 0 |
| `unknown`/abstention precision | yüksek iyi | ≥ 0.80 (yanlış kesinlik üretmeme) |
| Non-abstain coverage (abstain etmeyen payı) | — | ≥ 0.10 (R51 devralınan kapı; aşırı abstain yasak) |
| Abstention share (abstain payı) | düşük iyi | ≤ 0.50 |
| ECE (10-bin) | düşük iyi | bozulma ≤ 0.02 (taban'a göre) |
| Non-inferiority (mevcut görevler) | — | mevcut Laya BEV görevinde F1 düşüşü ≤ 0.01 |
| Non-inferiority (güvenlik) | — | firewall/risk kararlarında **sıfır** gerileme (kapı, eşik değil) |

**Karar kuralları (dondurulmuş):**

- Paired-bootstrap: seed `4394`, resamples `2000`, güven `0.95`.
- `GAIN`: macro-F1 paired CA alt sınırı > 0 **ve** her sınıf F1 ≥ taban **ve**
  `unknown`/abstention precision ≥ 0.80 **ve** non-abstain coverage ≥ 0.10 **ve**
  abstention share ≤ 0.50 **ve** ECE bozulması ≤ 0.02 **ve** mevcut Laya BEV görevinde
  F1 düşüşü ≤ 0.01 **ve** güvenlik non-inferiority geçti. Tablodaki tüm satırlar GAIN
  koşuludur; hiçbiri yalnız yardımcı değildir.
- `MEASURED_NO_GAIN`: metrikler ölçüldü, `GAIN` koşulu sağlanmadı.
- `INSUFFICIENT`: holdout adjudication `PENDING`, örnek yetersiz veya sızıntı kapısı kırmızı.
- `REJECT`: güvenlik non-inferiority geriledi veya sızıntı kanıtlandı.
- `NOT_MEASURED`: gözlenmeyen maliyet/kanıt için (Laya denetimindeki gibi).

## 6. Pilot ve güç gerekçesi (dondurulmuş)

Örnek sayısı "kanıt" sayılmaz; güç hesabıyla gerekçelenir (biçim: `coder-learning-g3-power-cost-preregistration-20261030.md`).

- `alpha 0.05` / `power 0.8` → `z_alpha 1.96`, `z_power 0.84`.
- **Gözlem birimi (dondurulmuş):** bir **parça** (konuşma, en az iki tur). Eşlenmiş gözlem,
  aynı parça üzerinde D ve B kollarının macro-F1 katkısı arasındaki farktır; birim `delta_i =
  f1_D(parça_i) − f1_B(parça_i)`. Sınıf-bazlı F1, önce parça düzeyinde hesaplanıp sonra
  bölme genelinde mikro-ortalanır; `delta_i` bu mikro-ortalamanın parça katkısıdır.
- **Pilot:** ilk 40 parça (calibration bölmesinden, holdout dışı) üzerinden `delta_i`
  dizisinden `sigma` = örnek standart sapması. `sigma`, §5 birincil ölçüsü olan macro-F1
  farkıyla **aynı ölçektedir**; pilot holdout'tan **ayrıdır**.
- **Asgari anlamlı etki (dondurulmuş):** `MIN_EFFECT = 0.05` macro-F1 (Laya R50 paired Brier
  iyileşmesinin 0.01 eşiğiyle aynı ölçek değil; yorumlayıcı için daha büyük etki aranır).
- `requiredSample = ceil(((z_alpha + z_power) * sigma / MIN_EFFECT)^2)`.
- `powerMet = holdoutSize >= requiredSample`. `powerMet = false` ise sonuç `INSUFFICIENT`'tır;
  küçük örnek "kanıt" gibi sunulmaz.
- `sigma`, `requiredSample`, `powerMet` sonuç belgesinde kilit tabloda raporlanır.

## 7. CPU bellek/gecikme ve JS parity

- **CPU bütçesi (dondurulmuş hedef):** tek parça inference CPU p95 ≤ 50 ms (ısınma sonrası
  1000 parça; makine ve Node sürümü raporlanır). RAM tepe ≤ 512 MB.
- **JS parity (dondurulmuş kapı):** model `@receptron/laya` (Node) veya eşdeğeri üzerinden
  çalışmalı; ONNX export **tek başına kabul değildir** (plan D). Parite, `results/r50_ft.json`
  gibi donmuş bir referans çıktısına karşı ölçülür; parite ölçülmeden model runtime'a alınmaz.
- **FEASIBILITY_BLOCKED:** parity veya bellek/gecikme bütçesi sağlanamazsa bu sonuç açık
  kaydedilir; runtime yasağı sessizce değiştirilmez.

## 8. Karar ve raporlama

- Sonuç ayrı bir belgede (`cog-d-interpreter-result-*.md`) ve ayrı PR'da raporlanır.
- Kaynak SHA, öğretmen revision + dosya hash'leri, holdout adjudication durumu, `sigma`,
  `requiredSample`, `powerMet` ve tüm sınıf-bazlı metrikler raporlanır.
- **Bağlı/ölçüldü ayrımı:** kodda bulunma ≠ üretimde kullanılma ≠ ölçülmüş kazanım.
- Gain yoksa `MEASURED_NO_GAIN`, kanıt eksikse `INSUFFICIENT`, güvenlik gerilerse `REJECT`
  dürüstçe yazılır. Varsayılan terfi **ayrı** bir karardır; bu ön-kayıt hiçbir varsayılanı
  değiştirmez.

## 9. Kapsam dışı (bu ön-kayıt iddia etmez)

- Öznel yaşantı veya insan duygusunu kesin bilme iddiası.
- Laya'yı terfi ettirme; `DEFAULT_MODE` `shadow` kalır.
- C şemasına etiket alanı ekleme; yeni 0.8B paralel hat açma.
- Yorumlayıcı çıktısının firewall/risk/trust/onay girdisi olması.
- Üretken sohbet (o E #4395 kapsamıdır) veya duygu–sohbet–eylem döngüsü (F #4396).
- Online ağırlık güncelleme, yeni kalıcı duygu deposu, fizyolojik eşik.

## 10. Sonraki adım

1. Pilot (40 parça, calibration) → `sigma` ölçümü.
2. Corpus kurulumu: insan etiketli Türkçe çok turlu set, §3 bölme kurallarıyla.
3. Öğretmen seçimi: §2 kapıları + §3 calibration; holdout açılmadan.
4. Holdout adjudication; ölçüm koşucusu ve sonuç belgesi (ayrı PR).

Bu adımlar D'nin kalan işidir; bu ön-kayıt onları başlatmaz, yalnız dondurulmuş eşikleri ve
sırayı kaydeder.
