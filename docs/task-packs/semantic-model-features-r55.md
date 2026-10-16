# R55 PR1: cümleler arası özellik sözleşmesi

`lib/semantic-model-text-features.js` içindeki `v2` dışa aktarımı,
`huqan-semantic-text-v2` sözleşmesini açık seçimle sunar. `stored.text` öncül,
`incoming.text` hipotezdir. Dil zorunlu olarak `en` veya `tr` seçilir:

```js
const { v2 } = require('./lib/semantic-model-text-features');
const record = {
  stored: { text: 'Kitaplar masadadır.' },
  incoming: { text: 'Kitap masada değil.' },
};
const features = v2.encodeTextPair(record, { language: 'tr' });
const baseline = v2.encodeTextPair(record, { language: 'tr', hypothesisOnly: true });
```

Çıktı `featureSpecDigest`, `dimensions`, sıralı `Uint32Array indices` ve aynı
uzunlukta `Float32Array values` içerir. 2^18 boyutlu uzay seyrek tutulur.
FNV1a UTF-16 hash çakışmalarında farklı özelliklerin değerleri toplanır;
yinelenen aynı sözcük veya bigram bir kez sayılır. Ham metin başına sınır
2048 UTF-16 kod birimidir. Sözcük içermeyen giriş ve bilinmeyen dil reddedilir.

Özellikler: hipotez unigram/bigramları, öncülde olmayan hipotez sözcükleri
(yüzey ve gövde), hipotezdeki benzersiz sözcüklerin örtüşme oranı, uzunluk
kovaları/oranı/yönü ve iki cümlenin olumsuzluk bayrakları. Yalnız-hipotez
seçimi öncülü okumaz; aynı hipotez koordinatlarını kullanır. Etiket, split,
öğretmen ve inceleyen kimliği okunmaz. Öğrenici, kullanılan özellik digest'i
yanında yalnız-hipotez seçimini de kendi artifact sözleşmesinde kaydetmelidir.

Türkçe büyük `I/İ` dönüşümü yerel ayardan bağımsızdır. Gövde örtüşmesi mevcut
korumalı hal/çoğul ve kopula normalizasyonunu kullanır; ham unigramlar ayrıca
korunur. Özel adın apostroftan sonraki eki gövde karşılaştırmasından çıkarılır.
Olumsuzluk `değil/yok/hiç/asla`, `-madı/-medi`, `-maz/-mez` ve `-mıyor` ailesinin
sınırlı çekimleriyle temsil edilir. Bu, tam Türkçe morfoloji çözümleyicisi
değildir: yalın `-ma/-me` belirsizliği ve tüm zaman/kişi çekimleri çözülmez.
Normalizasyon yardımcıları değişirse sabit özellik örnekleri ve sözleşme
sürümü birlikte değerlendirilmelidir.

V1'in 146 boyutlu varsayılanı, digest'i ve dört mevcut artifact'ı korunur.
V1 yükleyici v2 digest'ini reddeder. Bu PR bir özellik kodlayıcısı sunar;
v2 öğrenici, yeni artifact, lisanslı veri, kalibrasyon veya R50 kalite artışı
iddiası içermez. Canlı model `shadow` kalır ve `CANDIDATE_ONLY` korunur.
Repo dışında olduğu bildirilen deney betikleri bu çalışma alanında yoktur;
taşındıkları veya SNLI sonuçlarının yeniden üretildiği iddia edilmez.

İki dakikalık göz testi:

```sh
node --test test/semantic-model-text-features.test.js
```

Beklenti: EN/TR özellikleri, yalnız-hipotez izolasyonu, sabit digest/koordinat
örnekleri ve v1 artifact uyumluluğu dahil 9 test geçer. Aynı test dosyası mevcut
Linux/Windows/macOS, Node 22/24 portability iş akışında da çalışır.
