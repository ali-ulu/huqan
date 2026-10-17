# Modelsiz metin gereksinimlerinden proje planı

`coder create --requirements-text` açık ve sınırlı bir Türkçe girdi dilini mevcut
proje üreticisine bağlar. Girdi rota ve davranış örneklerini bildirir; algoritma
ailesi, dosya listesi ve uygulanacak değişiklikler mevcut üretici tarafından
çıkarılır. Bu giriş serbest doğal dil anlayışı veya genel yazılım sentezi değildir.

Örnek `istek.txt`:

```text
proje iki-kat
POST /iki-kat
örnek [] => []
örnek [2] => [4]
örnek [-3,4] => [-6,8]
kabul [5] => [10]
kabul [-2] => [-4]
kabul [1,3] => [2,6]
```

Planı dosya yazmadan görmek için:

```sh
node cli.js coder create istek.txt --requirements-text --dry-run --json
```

Boş bir hedef klasörde mevcut başlatma izni ve bağımsız HTTP testleriyle uygulamak için:

```sh
node cli.js coder create istek.txt --requirements-text --root /hedef/bos-klasor --initialize-project --source-root /kaynak/depo --json
```

`--source-root`, mevcut başlatma sözleşmesine uygun temiz kaynak Git deposudur.
Normal yetki, kaynak bütünlüğü, kabul testi ve rollback kontrolleri uygulanır.
İzin ve kayıtlar metinden çıkarılan `project_spec` belirtimine bağlanır.
Yanlış bir `kabul` sonucu aday seçimini değiştirmez; bağımsız testin başarısız
olmasına ve üretilen dosyaların geri alınmasına neden olur.

## Girdi sözleşmesi

- İlk dolu satır `proje <ad>` biçimindedir. Ad, mevcut proje adı sözleşmesindeki
  küçük ASCII harf, rakam ve tirelerden oluşur.
- Hesaplanan API için `POST /rota` ardından `örnek <girdi> => <sonuç>` ve
  `kabul <girdi> => <sonuç>` satırları gelir. `ornek` de kabul edilir.
- Her POST rotasında 3–32 eğitim ve 3–32 kabul satırı gerekir. Girdi en çok
  128 tam sayı içeren JSON dizisidir; sonuç tam sayı veya böyle bir dizidir.
  Sayılar güvenli tam sayıdır, mutlak değerleri en çok 1.000.000'dır. Eksi sıfır reddedilir.
- Sabit JSON API için `GET /durum => {"ok":true}` kullanılır. Gövde mevcut
  statik tarifin JSON nesnesi sözleşmesini izler. GET ve POST aynı projede
  karıştırılamaz; mevcut üreticinin iki ayrı tarifine yönlendirilir.
- En çok 8 rota, 16 KiB UTF-8 metin ve mevcut ASCII rota yolu sözleşmesi
  desteklenir. Boş satırlar, CRLF ve baştaki UTF-8 BOM kabul edilir.
- Tanınmayan satır, yinelenen rota, eksik örnekler, sınır aşımı ve geçersiz JSON
  reddedilir. Ayrıştırma hatası özgün satır numarasıyla raporlanır.
- Eğitimde boş dizi bulunması, eğitim/kabul ayrılığı, çözüm bulunabilirliği ve
  aile belirsizliği mevcut proje üreticisi tarafından ayrıca denetlenir.

POST araması, `compute.family` belirtilmeyen mevcut aile seçimini kullanır.
Birden fazla aile eğitim örneklerine uyarsa `PROJECT_COMPUTE_FAMILY_AMBIGUOUS`
ile durur; kabul örnekleri seçimde kullanılmaz. Arama ve yeniden kullanım
maliyeti mevcut plan raporlarında kalır.

Metin modu yalnız `coder create` için geçerlidir. Diğer komutlarda bu bayrak
reddedilir. Bayraksız JSON görev ve proje girişleri mevcut davranışını korur.
Dosya adaptörü en fazla 16 KiB + 1 bayt okur, geçersiz UTF-8'i reddeder ve
ayrıştırıcıya yalnız metin verir; ayrıştırıcı dosya açmaz veya kod çalıştırmaz.
