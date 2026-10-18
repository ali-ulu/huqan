# Karma yöntem aktarımının eşli ölçümü

GÖZLENDİ: üç sabit görevde kaynak mühürlü metin–sayısal yöntem yeniden
kullanıldı. Bu ölçüm yeni algoritma öğrenimini veya genel kodlama yeteneğini
kanıtlamaz. Eğitim dahil edildiğinde bu koşuda süre ve bağımsız doğrulayıcı
çağrısı tasarrufu görülmedi.

## Tekrar üretim ve ölçüm sınırı

```powershell
node --test test/coder-mixed-learning-gain.test.js
```

Testin TAP diagnostic satırı JSON kanıtını içerir. Üç hedef görev, farklı yöntem
kontrolü, başlangıç kaynakları, gereksinimler, bağımsız Unicode kabul girdileri
ve SHA256 özetleri eğitim başlamadan belirlenir. Cold ve warm kolları aynı
kaynak, kabul testi ve kaynak prosedürüne ait qualification dosyalarını alır.
Warm koluna aday bellek dosyası ve `reuseMemory` eklenir. Farklı proje yolları,
iki fonksiyonun adları ve parametreleri değiştirilir. Çalıştırma sırası
cold/warm, warm/cold, cold/warm olarak dönüşümlüdür.

Her eğitim/transfer gerçek CLI'ı ayrı Node sürecinde çalıştırır. Kaynak kayıtları
aynı SQLite journal üzerinden doğrulanır; her CLI sonrasında journal tekrar
açılıp ilgili kaynak manifesti okunur. Kaynak adayın ve öğrenilmiş kaynak
dosyalarının baytları korunur. İki kol da değişmeyen CLI varsayılanı olan en
fazla sekiz aday denemesini kullanır. Kaynak veya üretim kodu değiştirilmez.

`wallMs`, `performance.now()` ile yalnız `spawnSync` çağrısının etrafında
ölçülür: CLI başlangıcı, bellek kaynak doğrulaması, qualification, yeniden
doğrulama ve kabul çalıştırması dahildir. Fixture/Git hazırlığı, bağımlılık
kurulumu ve sonrasındaki journal açma bu sürenin dışındadır. Dahili aşamalar
ayrı zamanlanmadı; CPU maliyeti **ölçülmedi**.

`processes`, kabul dosyasının başında kalıcı loga yazılan işaretlerden sayılan
**bağımsız `accept.js` çağrılarıdır**; bütün alt süreçlerin sayısı değildir.
Başarı işaretleri ayrı sayılır ve gerçek aday denemeleriyle karşılaştırılır.
String aramasının `enumerated` sayısı gözlenir. Affine hedef yalnız 65 değerinde
`searchBudget` bildirir; bütçe gerçek enumerasyon sayısı diye sunulmaz.
Warm için sıfır fresh enumerasyon, kaynak doğrulamanın bedava olduğu anlamına
gelmez. Test sıcak kolun daha hızlı olduğunu iddia veya assert etmez.

## Gözlenen tek koşu

2026-10-18, Windows 10.0.26300 x64, Node v22.22.0 / ABI 127.
Üretim tabanı: `4ac4af9319a43a1950daf2f1d8d3cf894c1757dc` (#4023
`998804a8` ve güncel main `613d775e` birleşimi). Çalıştırılan ölçüm dosyasının
bu commit üzerinde henüz commit edilmemiş test eki olduğu ayrıca belirtilir.
Test sonucu **1/1 PASS**, exit 0; dosya süresi 21.133 saniye.

| Görev | Cold ms | Warm ms | Cold / warm kabul çağrısı | Cold / warm string enumerasyonu |
| --- | ---: | ---: | ---: | ---: |
| first | 2059.771 | 2132.271 | 1 / 1 | 1885 / 0 |
| second | 2592.504 | 2235.765 | 1 / 1 | 1885 / 0 |
| third | 2477.435 | 2247.678 | 1 / 1 | 1885 / 0 |
| Toplam | 7129.711 | 6615.714 | 3 / 3 | 5655 / 0 |

Eğitim ayrıca 2087.213 ms, bir kabul çağrısı ve 1885 string enumerasyonu aldı.
Eğitim dahil warm toplamı **8702.926 ms ve dört kabul çağrısıdır**; cold toplamı
7129.711 ms ve üç çağrıdır. Eğitim dahil enumerasyon 1885'e iner, fakat bu
toplam CPU veya toplam iş tasarrufu ölçümü değildir. Üç görev de her iki kolda
bağımsız kabulü geçti. Bu tek koşu istatistiksel hızlanma veya amortizasyon
eşiği kanıtı değildir; makine yükü ve işlem başlangıç maliyeti kontrol edilmedi.

Native bağımlılık kurulumu bu çalışma kopyasında VS C++ derleyicisi eksikliğinden
başarısız oldu. Ölçüm mevcut komşu `coder-mixed-learning/node_modules` üzerinden
`NODE_PATH` ile çalıştırıldı. İki `package-lock.json` SHA256 değeri eşitti:
`9f46e7f63eb145c24828451c8281dc25fed470a376474795856b8a703cb7ca4f`.
better-sqlite3 13.0.3 gerçek in-memory `SELECT 1` sorgusu geçti. Aynı bağımlılık
ortamı her iki kolun CLI süreçlerine miras kaldı; yeni kurulum başarısı iddiası
yoktur. Konfigürasyondaki bu dosyaya ait 21.133 s ağırlık bu yerel Windows
koşusundan gelir; diğer dosyaların önceki ölçümleri korunur, nightly ölçüm bu
tek yerel başlangıç ağırlığını ileride yenileyebilir.

## Karşı örnekler ve regresyon sınırı

`HUQAN_GAIN_DISABLE_REUSE=1` ile aynı test çalıştırıldığında gerçek warm kolu
belleği kullanmaz; `memoryReuse.attempted === true` kontrolü kırılır (exit 1).
Bu, yalnız cold çözümün başarılı olmasının öğrenme kanıtı sayılmasını engeller.

Farklı yöntem kontrolünün eğitimi boşluksuz girdiler içerir; bağımsız kabul
baş/son boşlukları korumayı ister. Kaynak trim+lower yöntemi önce denenir ve
başarısız olur. Her iki hedef geri alınır; ortak bütçedeki ikinci denemede
farklı fresh lower yöntemi kabulü geçer. Gözlenen iki çağrı, bir başarı,
2387.992 ms; kaynak bellek değişmez. Bu, yeni yöntemin bellek tarafından
öğrenildiği iddiası değildir.

Her kabul koşumu ayrıca başlangıçta da doğru olan `text('42') === '42'`,
`number(-4) === -3` ve hedef dışı `sentinel.js` değerini kontrol eder.
Sentinel baytları her CLI sonrasında değişmemiş olmalıdır. Regresyon kanıtı
bu kontroller, üç cohort kabulü ve kaynak değişmezliği ile sınırlıdır;
genel regresyon oranı, görülmemiş iş aileleri ve tüm proje testleri ölçülmedi.
