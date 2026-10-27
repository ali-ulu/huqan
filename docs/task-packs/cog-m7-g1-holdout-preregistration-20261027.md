# M7 / G1 bağımsız görev ölçümü: ön-kayıt kilidi

Durum: **KİLİTLİ — sahip onayı 2026-10-27** (sentetik etiketli corpus, |Δ| = 0.15 ve
32-64 grup, iki yönlü hipotez). Metin bu imzalı commit ile sabitlenir. Runner PR'ı
manifest digest'ini alır, holdout ancak ondan sonra koşulur. Sonuçlar bu belgeye
eklenmez; ayrı rapor/PR ile verilir. Herhangi bir değişiklik yeni sürüm gerektirir.

İlgili iş: #4065 (G1 sahibi), epic #4060. Plan: `docs/cognitive-architecture-plan.md` §7 G1
son maddesi ("ölçülen düzelme, dondurulmuş ve öğrenmede kullanılmayan bağımsız
görevlerde doğrulanır"). Önceki taslak: `cog-m7-salience-preregistration-20261022.md`;
bu belge onun "Holdout öncesi açık kilitler" tablosunu doldurur, onu değiştirmez.

## 1. Kaynak ve kollar

- Aday kaynak SHA: `f626370538cb59c586f9b0b462f1039488f2c07c` (#4350 sonrası main).
  Ölçüm runner'ı ayrı PR'la eklenir; birleştiği SHA manifestte ayrıca sabitlenir.
  Runner dışında üretim kodu ölçüm sırasında değişmez.
- Giriş: üretim HTTP yolu `POST /api/v2/agent/coder/{cases,runs}` (#4346, #4348),
  `cognition: true`, gerçek Coder yürütmesi, gerçek oversight runtime, gerçek journal.
- **Aday kol:** mevcut M7 (salience → scheduler urgency).
- **Kontrol kol:** aynı SHA, aynı gözlem/öğrenme/ödül akışı; yalnız scheduler'a giden
  `urgency` sıfırlanır (mevcut Lab mekanizması `lib/cognitive-lab-m7-runtime.js:51`).
  Cognition'ı kapatmak kontrol değildir: gözlemi de kapatır.
- İki kol her epizotta aynı başlangıç graf/journal kopyasından, ayrı workspace ve depo
  kopyalarıyla başlar; bir kolun yazısı diğerine veya sonraki epizoda taşınmaz.

## 2. Hipotez (iki yönlü)

H1: Eşit iterasyon bütçesinde M7 urgency katkısı, epizot başına bağımsız kabulü geçen
görev oranını kontrolden **farklı** kılar.

Yön önceden iddia edilmez. M7, başarısız bir iş türüne dikkati artırır ve aynı türden
sonraki görevi öne alır. Başarısızlıklar türe göre kümeleniyorsa bu, başarı oranını
**düşürebilir**. Zarar da kazanç kadar raporlanır.

## 3. Görev corpus'u

Gerçek repolardan yeterli Coder görevi bugün yoktur. Coder yalnız `initialize_project`
ve `replace_text` yürütür. Bu ölçüm bu yüzden **sentetik kontrol corpus'u** ile yapılır
ve sonucu "G1 sentetik ölçümü" olarak etiketlenir. G3 ayrıca gerçek görev corpus'u
ister; bu ölçüm onun yerine geçmez.

- Görev türü: `initialize_project`, arşetip `node_computed_json_api`, aileler
  `lib/coder/project-compute.js` `FAMILIES` (array-fold, array-guarded-fold,
  array-threshold-fold, array-stateful-fold, array-map, array-filter).
- **Grup:** bir (aile, hedef fonksiyon) çifti. Hedef fonksiyon seed'li üreteçten çekilir.
  Aynı fonksiyondan türetilen varyantlar aynı gruptadır.
- **Doğal başarısızlık:** sentez yalnız `examples`'tan program çıkarır. Kabul,
  `acceptanceExamples`'ta (ayrı girdiler) bağımsız denetlenir. Örneklere uyan ama yanlış
  genelleyen program gerçek `contradiction` üretir. **Hata enjekte edilmez**: kabul
  örnekleri hedef fonksiyonun gerçek çıktısıdır.
- Her grubun spec'i, hedef fonksiyonu ve kabul girdileri içerik digest'iyle manifestte yer alır.

## 4. Bölme ve sızıntı

- Üreteç seed'i `20261027`. Gruplar sırayla **train** (8), **calibration** (8) ve
  **holdout** (N, §6) bölmelerine atanır.
- Aynı (aile, fonksiyon) ya da aynı digest iki bölmede bulunamaz. Runner bunu koşudan
  önce denetler; ihlal REJECT'tir.
- **Train:** başlangıç geçmişi. Her tür için `DEFAULT_SUMMARY_WINDOW − 1` gerçek Coder
  sonucu bir kez üretilir ve donmuş snapshot olur.
- **Calibration:** yalnız kurulum, süre, doğal başarısızlık oranı ve σ tahmini içindir.
  Sonucu gain sayılmaz.
- **Holdout:** yalnız bir kez koşulur. Önceden açılmaz.

## 5. Epizot, bütçe ve politika

- Bir epizot bir holdout grubunun iki türünden 4 onaylı görevdir (her türden 2).
  Kuyruk sırası epizot seed'iyle karıştırılır.
- Bütçe: `maxIterations: 2` (4 görevden 2'si yürür). Her iki kol aynı limitleri kullanır.
- **Politika:** epizotlar arası taşıma yoktur. Her epizot donmuş train snapshot'ından
  başlar. Epizot içinde M7'nin çevrimiçi uyarlaması serbesttir, ölçülen mekanizma budur.
- Seed listesi: `[1, 2, 3]`. Her holdout grubu 3 seed'le koşulur. Grup skoru 3 seed'in
  ortalamasıdır; seed'ler bağımsız örnek sayılmaz.
- Görev başına Coder zaman aşımı mevcut varsayılandır. Aşım başarısızlıktır; paydadan
  çıkarılmaz.

## 6. Ölçü, etki ve örnek sayısı

- **Birincil ölçü:** grup başına (aday başarı oranı − kontrol başarı oranı). Başarı,
  yürütülen görevin bağımsız kabulü geçmesidir. Adım seçimi, `step.ok` veya kuyruk
  sırası başarı değildir.
- **Asgari anlamlı etki:** |Δ| = 0.15 (epizotta yürütülen 2 görevden ortalama 0.3 görev farkı).
- **Örnek sayısı:** `N = clamp(ceil(((1.96 + 0.84) · σ̂ / 0.15)²), 32, 64)` holdout grubu.
  σ̂, calibration'daki grup farklarının standart sapmasıdır (α = 0.05 iki yönlü, güç 0.80).
  N calibration bittikten ve holdout açılmadan önce bu formülle hesaplanır, manifestte
  kilitlenir ve sonradan değişmez.

## 7. Karar kuralları

- **Belirsizlik:** grup farkları üzerinde %95 eşli bootstrap güven aralığı
  (10.000 tekrar, seed `20261027`). Destekleyici olarak işaret testi raporlanır.
- **Eski beceri non-inferiority:** epizot içinde hiç başarısızlık gözlenmeyen alt
  tabakada aday, kontrolden en fazla 0.05 daha düşük olabilir (GA alt sınırı > −0.05).
- **Maliyet:** model ve ağ çağrısı 0. Epizot duvar süresi medyanı kontrolün 1.5 katını
  aşmaz. Bellek ve Coder çağrı sayısı ayrı raporlanır.
- **Etiketler:**
  - **GAIN:** GA alt sınırı > 0, non-inferiority ve maliyet geçer, bütünlük temiz.
  - **MEASURED_NO_GAIN:** geçerli deney, GA 0'ı içerir. GA üst sınırı < 0 ise ayrıca
    **zarar** olarak yazılır.
  - **INSUFFICIENT:** kurulum hatası, N'ye ulaşılamaması ya da bölme denetiminin geçmemesi.
  - **REJECT:** yetki/onay bypass'ı, workspace sızıntısı, yanlış tamamlandı bildirimi
    veya bölmeler arası sızıntı. Ortalama artış bunu telafi etmez.
- Hiçbir etiket üretim varsayılanını kendiliğinden değiştirmez (cognition opt-in kalır).

## 8. Anti-vakalar ve mutasyon

- Önceden seçilen anti-vakalar:
  - hiç başarısızlık olmayan epizot,
  - iki türün de başarısız olduğu epizot,
  - tek türden oluşan epizot.
  Adayın bunlarda kaybetmesi şart değildir. Bütünlük ve doğruluk denetlenir.
- Gözlem bağlantısını kesen mutasyon (`observeAcceptance → null`) holdout'tan önce
  calibration'da bir kez koşulur. Aday kol kontrolle aynı seçimleri yapmalıdır; yapmazsa
  runner geçersizdir (INSUFFICIENT).

## 9. Kilit tablosu (önceki taslaktaki açık maddeler)

| Kilit | Bu belgedeki karşılığı |
| --- | --- |
| Aday ve kontrol SHA'ları | §1 (aday SHA; runner SHA'sı birleşince manifestte) |
| Yalnız urgency farkı kontrolü | §1 kontrol kol + §8 mutasyon |
| Görev corpus'u, gruplar, digest'ler | §3 (sentetik; digest'ler manifestte) |
| Bölmeler ve sızıntı denetimi | §4 |
| Holdout politikası | §5 (epizotlar arası donmuş, epizot içi çevrimiçi) |
| Kabul oracle'ları ve yürütme yolu | §3 bağımsız `acceptanceExamples`, §1 HTTP yolu |
| Bütçe, seed, durdurma | §5 |
| Asgari etki, güç, grup sayısı | §6 |
| Non-inferiority ve maliyet sınırları | §7 |
| Belirsizlik yöntemi, eşikler, evaluator | §7; evaluator sürümü runner PR'ında |

## 10. İddia sınırı

Bu ölçüm, sentetik ve model kullanmayan Coder görevlerinde M7'nin seçim etkisini ölçer.
Gerçek mühendislik görev başarısını, G2/G3 kabulünü veya genel öğrenme kazancını kanıtlamaz.
