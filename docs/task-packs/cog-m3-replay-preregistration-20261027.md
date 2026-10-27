# M3/B4 — Replay seçimi için ölçüm ön-kaydı

İş: [#4069](https://github.com/ali-ulu/huqan/issues/4069).
Program: [#4060](https://github.com/ali-ulu/huqan/issues/4060), G3 ayrı kalır.
Tarih: 2026-10-27. Durum: `PROTOCOL_DRAFT`, deney `NOT_RUN`.
Bu dosya protokolü tanımlar; corpus veya çalıştırıcı hazır olduğu iddiası değildir.

## 1. Kaynak ve yeniden kullanım

Kaynak tabanı: `3127da8561ac3fefe0fce972d310c006cc787cea`.
#4354'ün aday bağlantısı `a8843e7758ce927e61090f695eed6c9f5273dc25` üzerindedir;
bu referans merge veya CI başarısı anlamına gelmez. Deney, kabul bağlantısının
gerçek yürütme kanıtını ve çalıştırılan kaynak SHA'sını ayrıca gerektirir.

Yeniden kullanılacak yüzeyler:

- `lib/cognition/replay-priority.js`: ölçülmüş sinyallerin uygunluğu ve seçim.
- `lib/cognition/replay-generalize.js`: bağımsız destek ve tutarlılık kapıları.
- `lib/cli-replay.js`: native kaynak, dependency, derleme ve qualification akışı.
- `lib/experience/learning-intake.js` ve `lib/experience/compiler.js`:
  mühürlü olumlu kaynaklardan somut, sürümlü yöntem ve ayrı girdi doğrulaması.
- `lib/cognitive-lab-b4-evaluator.js`: mevcut contract ve paired bootstrap.
- `test/coder-learning-gain-accuracy-cost.test.js`: gerçek CLI alt süreci,
  diskten sonuç okuma, maliyet, restart ve yanlış yazma kontrolünün deseni.
- `docs/task-packs/b4-transfer-preregistration-20261004.md`:
  eksik tanımlı görev, oracle ayrımı ve kaynak/holdout sözleşmesi.

#4352'nin baseline/synthesis ile learned/adaptation karşılaştırması bu deney
değildir. Onun beş sentetik görevi bağımsız M3 kaynakları veya M3 sonucu sayılmaz.
Eski B4'ün kapısız A1 kolu da aşağıdaki recent-K kolunun yerine kullanılamaz.
Mevcut B4 `evaluate` görev düzeyinde bootstrap yapar ve `O` oracle kaydı ister.
Yeni kol anlamları, aile düzeyinde paired örnekleme, oracle ayrımı ve güven
kontrollerini bağlayan adapter uygulanmadan bu evaluator doğrudan yeterli sayılmaz.

## 2. Hipotez ve müdahale

H0: Aynı uygun kaynak havuzunda ve eşit K bütçesinde priority ile recent-K'nin
ürettiği adaylar arasında bağımsız görev doğruluğu farkı yoktur.
H1: Priority kolunun doğru-sonuç oranı recent-K'den yüksektir ve güven
regresyonu yoktur. Tek değişken epizot seçimidir; yetki veya kapı değişmez.

| Kol | Davranış |
| --- | --- |
| A0 | Yeni replay adayı olmadan mevcut HUQAN/bağlı yöntem; ikincil referans. |
| A1 | Aynı uygun havuzdan `at desc, episodeId asc` sıralı recent-K. |
| A2 | Mevcut `selectReplay` ile priority sıralı top-K. |

Birincil karşılaştırma A2−A1'dir. A0'a karşı fark tek başına replay seçiminin
etkisi sayılmaz. K=32; uygun epizot sayısı küçükse iki kol da aynı
`min(32, uygun epizot sayısı)` üst sınırına sahiptir. K sonuçlara göre değişmez.
Seçilen benzersiz epizot kimlikleri ve gerçekten harcanan bütçe kaydedilir.

Uygunluk iki kolda aynıdır: aynı workspace, aynı karar öncesi zaman sınırı,
geçerli mühür ve gerçekten ölçülmüş PE/RPE. ABSTAIN veya eksik sinyal sıfır
sayılmaz. Öncelik sabitleri mevcut kaynaktaki 0.01, 0.6 ve 1.0; grup kapıları
en az 3 bağımsız kaynak ve tutarlılık en az 0.8 olarak korunur.

## 3. Kaynak, qualification ve holdout ayrımı

Örnekleme birimi farklı ID değil, bağımsız kaynak/artefakt ailesidir.
Kopya, ortak ancestor, aynı üretilmiş artefakt veya aynı kaynağın tekrar koşusu
tek gruptur. Train/source, qualification ve holdout grupları kesişemez.
Dosya hash'lerinin farklı olması tek başına bağımsızlık kanıtı değildir.

İki kol aynı mühürlü snapshot ve tam dependency evreninden seçim yapar.
Önce bir altküme seçip dependency grafını yalnız o altkümeden yeniden kurmak
yasaktır: seçilmeyen bir ara epizot bağımlılığı gizleyebilir.

Holdout hedefleri ve bağımsız oracle çalıştırıcıdan ayrı kilitlenir. Görev,
yöntemi kaynaklardan seçmeyi gerektiren niyet/hedef taşır; doğru `find/replace`
metnini doğrudan görev girdisine vererek yapısal eşitlik deneyi yapılmaz.
Tam tanımlı oracle sonucu yalnız ulaşılabilir tavanı gösterir, eğitim girdisi olmaz.
Holdout sonucu PE/RPE, yöntem seçimi veya qualification'a geri beslenmez.

## 4. Aynı aday ve yürütme hattı

Her kol aynı grouping, intake, compiler, qualification, promotion/canary,
bağımsız admission, canlı acceptance ve Coder yolunu kullanır.
Replay çıktısı `registered:false`, `CANDIDATE_ONLY` kalır; otomatik onay yoktur.
Task/HEAD/workspace, dosya güvenliği, code-change gate ve rollback korunur.
Negatif destekten çalıştırılabilir olumlu yöntem üretilmez; policy/capability
öğrenilmez. `authorityDelta` yüzeyleri null kalır.

Seçilen destek, source hash'leri, parent/version, aday hash'i, qualification,
operatör kabulü ve gerçekten yürütülen hash ayrı kaydedilir.
Aday çıkmaması, qualification/kabul reddi, timeout ve kısmi sonuç örneklemden
çıkarılmaz. Beklenen güvenli ret doğru sonuç olabilir; çalışması gereken
görevde ret ise başarısızlıktır. Kaynak ve oracle etiketleri bunu önceden belirler.

Her kolun izole çalışma kopyası ve writable journal kopyası vardır; ortak kaynak
snapshot'ı değişmez. Tekrar süreçleri yeni bağımsız görev sayılmaz.

## 5. Donmuş metrik ve karar sınırları

Birincil metrik diskten ve bağımsız kabul testinden gözlenen correct-outcome-rate.
Modelin veya yürütücünün `ok` beyanı tek başına başarı değildir.
Mevcut B4 sözleşmesi korunur: seed=3310, resamples=2000, confidence=0.95,
meaningfulEffect=0, minimumSamples=24, minimumTransfer=8, wrongWriteTolerance=0.
24 bağımsız aile ve 8 transfer vakası alt sınırdır; güç analizi yerine geçmez.
Korelasyonlu tekrarlarla bu sayılar tamamlanmaz; bootstrap aile düzeyinde paired olur.

Her kolda yanlış yazma, yetki aşımı, kaynak değişikliği, sızıntı veya sahte başarı
varsa önce `REJECT` verilir; küçük örneklem/kill kriteri bu ihlali maskeleyemez.
Güven ihlali yokken yetersiz bağımsız kaynak, kilitlenmemiş split, iki kolun
aynı seçimi yaptığı etkisiz corpus veya eksik kanıt `INSUFFICIENT` olur.
Pozitif alt güven sınırı yalnız kilitli corpus için sınırlı seçim etkisidir;
pilot sonucu genel öğrenme kazanımı veya G3 kapanışı olarak raporlanmaz.

Eğitim/seçim/derleme/qualification/kabul/yürütme/rollback dahil wall time,
process/search sayıları ve tamamlanmayan görevler ayrı raporlanır. Kol sırası
kilitli seed ile dengelenir; cold/warm ve eşzamanlı makine yükü belirtilir.
Wall-time kazanımı ayrı karardır; doğrulukla birbirinin yerine geçirilmez.
CPU/bellek gerçekten ölçülmediyse `NOT_MEASURED`; model çağrısı sayısı
gözlem olmadan eski runner'ın örnek sayısından türetilmez.

Restart sonrası kabul edilmiş hash kullanımı, gerçek ret/rollback sonrası
önceki yöntemin korunması, farklı yöntem/ortam kontrolü ve eski beceri probe'u
ayrı raporlanır. Tek probe güçlü non-inferiority corpus'u yerine geçmez.

## 6. Çalıştırma öncesi kilit ve mevcut eksikler

Deneyden önce ayrı imzalı commit ve manifest şu alanları kilitler:
protokol hash'i, çalıştırıcı/kaynak SHA, corpus ve oracle hash'leri,
source/qualification/holdout grup listeleri, dependency snapshot hash'i,
kol sırası, K, sabitler ve ilgili kabul/test komutları.
Manifest bu protokole aykırı eşik veya sonuç-sonrası örnek seçimi yapamaz.
İçerik değişirse yeni protokol revizyonu ve yeni holdout gerekir; eski sonuç silinmez.

Şu anda çalıştırıcı, bağımsız corpus/split manifesti ve bunların hash'leri bu
teslimde üretilmedi. Recent-K ile priority'nin aynı tam dependency evrenini
kullanacağı ortak seçim/derleme bağlantısı da ayrıca uygulanıp sınanmalıdır.
Var olmayan bir test veya komut burada çalışır kabul edilmez.
Bu ön-kayıt bunlar olmadan deney başlatma veya kazanım raporlama izni değildir.

Sonuçlar bu dosyaya sonradan eklenmez; ayrı, kaynak SHA'lı rapor ve CI artefaktında
`NOT_RUN/INSUFFICIENT/REJECT/MEASURED` sınırlarıyla yayımlanır.
G3'ün birleşik sistem/çıkarma kolları, güç hesabı, değişmiş ortama uyum süresi
ve eski becerilerin önceden kilitli non-inferiority ölçümü ayrıca açık kalır.

Bu teslimin kontrolü: `git diff --check`; yalnız bu Markdown dosyası eklenir.
Deney, üretim kodu, mevcut sabitler, sürüm ve bağımlılıklar değiştirilmez.
