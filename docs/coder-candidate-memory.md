# Coder aday hafızası

Bu yol tamamen modelsizdir. Başarıyla tamamlanmış, mühürlü bir `replace_text`
kaynak yürütmesinin yöntemi açık bir komutla aday dosyasına kaydedilir. Sonraki
görev yöntemin metinlerini tekrar taşımadan bu dosyayı seçebilir. Saklamak,
yöntemi yüklemek veya kaydın hash'inin tutması yönteme doğruluk/kurulum yetkisi
vermez; çalışma anında mevcut kaynak, uygunluk, coverage ve güven kapıları
yeniden uygulanır.

Kaynak görev `qualificationPaths` içinde mevcut held-out dosyaları belirtir.
Coverage için yetersiz örnek varsa yöntem yürütülemez; eşikler değişmez.

```text
node cli.js coder remember source-task.json --root REPO --journal JOURNAL --run-id SOURCE_RUN --candidate-file .huqan/coder/candidates/method.json --json
node cli.js coder intent-task.json --root REPO --journal JOURNAL --run-id NEW_RUN --candidate-file .huqan/coder/candidates/method.json --json
```

İkinci görev aynı hedef yolunu ve `allowedPaths` listesini taşır; `find`,
`replace` ve `experience` taşımamalıdır. Kaynak run'ın workspace'i aynı
olmalıdır. Yöntem gövdeleri journal'a eklenmez; özel aday dosyasında saklanır.
Dosya 32 KiB ile sınırlıdır ve yalnız `.huqan/coder/candidates/*.json` altında
exclusive-create ile yazılır. Mevcut kayıt ezilmez; bağlantılı yollar reddedilir.
Her yükleme mühürlü kaynak ve learning proposal'ı yeniden okuyup karşılaştırır.

Öğrenilmiş bir yürütmeyi yeni capability kimliğiyle yeniden derlemek mevcut
bağı kıracağı için `routed_source_requires_original_candidate` ile reddedilir;
onun özgün aday dosyası yeniden kullanılabilir. Varsayılan kullanım hedef yolunu
korur; genel yazılım üretimini veya genel öğrenme kazancını sağlamaz.
B4 doğrulayıcı sonucunun `REJECT` olması değişmez.

## Otomatik yöntem seçimi

`node cli.js coder intent-task.json --root REPO --journal JOURNAL --use-memory --json`

Bu açık seçenek aday dosyası adını gerektirmez. Aynı workspace ve hedef yol için
saklanan yöntemleri mühürlü kaynaklarından yeniden doğrular; mevcut hedefte eski
metni tam bir kez bulunan tek aday seçilir. Seçim mevcut uygunluk, coverage,
güven ve yazma kapılarının yerine geçmez. Kaynak kod için gereken `--authorize`
ve görevde bildirilen `test` komutu aynı şekilde uygulanır.

Birden fazla uygun yöntem, bozuk kanıt veya bağlantılı aday yolu reddedilir.
Uygun yöntem yoksa hiçbir dosya oluşturulmaz veya değiştirilmez. Tarama en fazla
32 dizin girdisi ve 128 KiB hedefle sınırlıdır. `--candidate-file` ile birlikte,
proje oluşturma, dry-run veya remember modunda kullanılamaz.

Kabul testi gerçek CLI süreçleriyle JavaScript düzeltmesini öğrenir, yeniden
başlatıldıktan sonra farklı bağlam ve yeni test girişlerinde yöntemi seçip kodu
onarır. Aynı yöntem metni taşımayan görev hafıza kapalıyken reddedilir; hafıza
açıkken bağımsız testleri geçer. Bu dar tekrar kullanım kanıtıdır; farklı dosyaya
aktarımı, bilinmeyen hata için çözüm icadını veya geniş bir hold-out kümesinde
ölçülmüş genel öğrenme kazancını kanıtlamaz.

## Farklı hedef dosyaya aktarım

### Çok dosyalı isim değiştirme

Başarılı mühürlü `sequence` koşumunun 2–8 adet `rename_identifier` adımı da
aday olarak saklanabilir. Yeni görevin `operation` alanı yalnız
`{"type":"sequence","paths":["dst/export.js","dst/use.js"]}` içerir;
`allowedPaths` bu hedefleri kapsar ve `test.command` bağımsız doğrulamayı bildirir.
`--transfer-memory --authorize` ile yöntem hafızadan seçilir. Yol eşlemesi
kaynak adım sırasına göredir; öğrenilmiş `from`/`to` isimleri korunur.

Kaynak örneğin isimlerini bilmeden aktarım için intent
`operation.rename` alanını kullanabilir: `{"from":"beforeValue","to":"afterValue"}`.
Sistem bu gereksinimi kaynak yöntemin eski/yeni isim rollerine bağlar. Bu kısa
biçim bütün kaynak adımlar aynı eski/yeni isim çiftini kullandığında geçerlidir;
farklı çiftler içeren yöntemler bu intent için atlanır. `identifierBindings`
ile birlikte verilmesi reddedilir. Bağımsız test ve bütün güven kapıları korunur.

Farklı isimlerle aktarım için intent `operation.identifierBindings` alanını
ekleyebilir: örneğin `{"oldName":"beforeValue","newName":"afterValue"}`.
Bu nesne kaynak adımlardaki bütün farklı isimleri tam bir kez eşler; hedef
isimleri geçerli ve birbirinden farklı olmalıdır. Yeni isimler yöntemin ayrı
hash/kimliğine bağlanır ve yönlendirme sırasında tekrar doğrulanır. Bu açık
gereksinim eşlemesidir; sistem istenen yeni isimleri kendiliğinden tahmin etmez.

Kaynak görevin `qualificationPaths` listesi bu ailede JSON dosyaları gösterir.
Kaynak bağlamını tekrar kullanmak için dosya
`{"format":"huqan-coder-rename-qualification","schemaVersion":1,"files":{"src/a.js":"...","src/b.js":"..."}}`
biçiminde olabilir. `files` bütün kaynak adım yollarını içerir. Yollar ve kod
isimleri doğrulanmış child yönteme göre bellekte uyarlanır; örnek dosyası
yazılmaz. İsim eşlemesi aynı anda uygulanır; yorumlar, metin sabitleri ve
ilgili olmayan dosyalar korunur. Çakışan çıktı yolları reddedilir.
Eski düz nesne biçimi hâlâ yeni hedef yollarını içeriklerine bağlar.
En az bir
isim yokluğu (`drift`) ve bir hedef isim çakışması (`ambiguous`) örneği coverage
kapısında doğrulanmalıdır; güncel hedef dosyaların tamamı ayrıca sınanır.
Bu örnekler gerçek bağımsız hedef testinin yerine geçmez. Başarısız hedef testi
bütün dosyaları geri alır ve negatif deneyim olarak mühürlenir.

Her aktarım kaynak yönteme bağlı ayrı hash/kimlik taşır; kaynak başarıları
yeni kimliğe güven puanı sağlamaz. Farklı adım sayılı veya hedefte uygulanamayan
sağlam kayıtlar seçimde atlanır; bozuk kayıtlar ve birden fazla uygun yöntem
reddedilir. Bu yol yeni isimleri kendiliğinden çıkarmaz veya genel yazılım
geliştirme ve öğrenme kazancını kanıtlamaz.

`node cli.js coder intent-task.json --root REPO --journal JOURNAL --transfer-memory --authorize --json`

`--transfer-memory` açıkça hafızadan seçim yapar ve farklı hedef yoluna aktarımı
etkinleştirir. Yeni görev hedefi, `allowedPaths` ve bağımsız `test.command`
bildirir; yöntem metnini taşımaz. Testsiz aktarım reddedilir. Kaynak aday ve
mühürlü kaynak yürütmesi değiştirilmez. Kaynak yol, metin hash'leri ve kaynak
yöntem hash'i yeniden doğrulanır; mevcut compiler bu kaynağa bağlı, yeni hedef
parametreleri ve ayrı hash/kimlik taşıyan bir yöntem türetir. Yönlendirme kanıtı
kaynak yolunu, kaynak hash'lerini ve yeni hedefi birlikte saklar.

Yeni hedef uygunluk/coverage ve olağan yazma kapılarını yeniden geçer. Kaynakta
başarı, yeni hedefte başarı sayılmaz: hedef testi gerçekten çalıştırılır;
başarısız doğrulama veya testten sonra değişmiş patch geri alınır, geri alma
diskten kontrol edilir ve negatif deneyim mühürlenir. Bu davranış aktarımın
doğrudan uygulama API'sinde de korunur. Kaynak kodun REVIEW izni ayrı kalır;
aktarım seçeneği BLOCK veya DRY_RUN_ONLY kararlarını kaldırmaz.

Kabul testi öğrenilen JavaScript düzeltmesini başka bir dosyada, kaynak örnekte
kullanılmamış girişleri kontrol eden gerçek Node testiyle uygular. Yeniden
açılan SQLite'da kaynak ve hedef bağlarını; kaynak dosya/adayın değişmediğini;
başarısız testte rollback ve negatif öğrenme kaydını doğrular. Bu, aynı literal
metin dönüşümünün dosyalar arasında kanıtlı aktarımıdır. Identifier uyarlaması
aşağıdaki ayrı seçenektedir. Algoritmaya uyarlama, bilinmeyen hatadan yeni çözüm
üretme ve geniş hold-out kümesinde genel öğrenme kazancı henüz sağlanmaz.

## Öğrenilmiş ifadenin değişken adlarını uyarlama

`node cli.js coder intent-task.json --root REPO --journal JOURNAL --adapt-memory --authorize --json`

Bu açık seçenek aktarımın test ve izin koşullarını korur; kaynak aritmetik
ifadesindeki identifier bağlarını hedef ifadeye bire bir eşler. Örneğin mühürlü
`n + 1 → n * 2` yöntemi, `value + 1` hedefinde `(value * 2)` üretir. Operatörler
ve sayılar kaynaktan gelir; yeni görev yöntem metni veya identifier haritası
sağlamaz. Replacement parantezlenerek çevredeki işlem önceliği korunur.

Desteklenen ifade grameri identifier, sonlu sayısal literal, parantez ve ikili
`+`, `-`, `*`, `%` işlemleridir. Bu tam JavaScript ayrıştırıcısı değildir:
çağrı/member ifadeleri, unary bağlamlar, BigInt, template, regex, division ve
JSX desteklenmez. Yalnız `.js`, `.cjs`, `.mjs` hedefler kabul edilir. Yorum ve
string içinden eşleşme türetilmez; birden fazla yapısal eşleşme veya yeni
replacement identifier'ı reddedilir. Mevcut 32 aday / 128 KiB sınırları korunur.

Kaynak parametreler hedef parametrelerden ayrı tutulur. Yönlendirme, güncel
hedef içeriğinden uyarlamayı tekrar hesaplar; değiştirilmiş bağlama veya kaynak
hash'i reddedilir. Coverage örnekleri yalnız okuma sırasında aynı identifier
bağlarıyla örneklenir; qualification dosyaları değiştirilmez ve drift/ambiguity
kapıları korunur. Kaynak başarıları hedef güvenine eklenmez. Hedefin bağımsız
testi başarısızsa rollback ve negatif deneyim kaydı aktarımda olduğu gibi işler.

Kabul testi yeniden başlatılmış gerçek CLI ve SQLite ile farklı identifier'lı
hedefi onarır; aynı hedef literal aktarımda reddedilir. Bu identifier uyarlaması
kanıtıdır; yeni algoritma icadı veya genel öğrenme kazanımı kanıtı değildir.

## Sayısal örneklerden modelsiz çözüm üretme

`node cli.js coder request.json --root REPO --journal JOURNAL --synthesize --authorize --json`

Görev replacement metni içermez. `operation` alanında `replace_text` türü ve
hedef yolu, `allowedPaths` içinde aynı yol, `test.command` içinde bağımsız
doğrulama komutu bulunur. `synthesis.family` değeri `affine-integer`,
`synthesis.examples` değeri `{ "input": 0, "expected": -2 }` biçiminde
3–32 örnektir; en az üç farklı girdi gerekir.

Arama 65 tamsayı katsayıyı (-32…32) dener; sabit terimi örneklerden türetir.
Girdiler, beklenen çıktılar ve sabit terim mutlak değeri en fazla 1.000.000 olan
güvenli tamsayılardır. Tek bir çözüm bulunmalı ve mevcut kod en az bir örnekte
yanlış olmalıdır. Desteklenen hedef, `.js` veya `.cjs` dosyasındaki tek
CommonJS unary arrow aritmetik modülüdür. Sözdizimi derlenerek kontrol edilir;
bu aşamada hedef kod çalıştırılmaz.

Üretilen değişiklik mevcut izin, bağımsız test, dosyadan geri okuma ve rollback
kapılarından geçer. Örnekleri karşılamak tek başına öğrenme izni vermez.
`synthesis.rememberFile` açıkça verilirse yalnız doğrulanmış başarılı çalışma
aday olarak saklanır; mevcut aday dosyası üzerine yazılmaz. Saklama başarısı
`synthesis.memory` alanında kod uygulama sonucundan ayrı raporlanır.

Kabul testi üç örnekten `3*x-2` çözümü üretir, örneklerde olmayan 5 ve 8
girdileriyle doğrular, saklar ve yeniden başlatılan CLI ile farklı dosya ve
değişken adına uyarlar. Bağımsız test başarısızsa kaynak geri alınır ve aday
saklanmaz. Bu sınırlı aritmetik aile içinde yeni çözüm üretme ve kalıcı yeniden
kullanma kanıtıdır; genel yazılım geliştirme veya genel öğrenme kazanımı henüz
kanıtlanmış değildir.

### Formül ailesinden ifade aramasına

`synthesis.family: "arithmetic-expression"` aynı CLI seçeneğiyle çalışır.
HUQAN hedef değişken, 0–3 sabitleri ve `+`, `-`, `*`, `%` işlemlerinden en
fazla iki işlemli ifade ağaçları oluşturur. Sabit hesaplama ve güvenli cebirsel
sadeleştirmeler eşdeğer tekrarları azaltır. En fazla 4.105 ağaç değerlendirilir;
örnekleri karşılayan ifadeler işlem sayısı ve metin sırasıyla sıralanır.

En fazla sekiz aday mevcut test/rollback döngüsüne verilir. Fazla eşleşmeler
`omittedCandidates` ile açıkça raporlanır; bütün olası programların denenmiş
olduğu iddia edilmez. Örnekleri karşılayan ilk aday bağımsız testi geçmezse
geri alınır ve sıradaki aday denenir. Hafızaya, gerçekten tutulan adayın
operation ve `sourceRunId` değerleri yazılır; ilk öneri otomatik öğrenilmez.

Gerçek CLI kabul testinde 0, 2 ve 4 girdileri için sıfır çıktısı hem sabit
sıfıra hem `% 2` işlemine uyar. Ayrı 5 ve 8 girdileri sabit sıfır adayını
reddeder; geri alma sonrası `% 2` adayı geçer ve başarılı denemenin mühürlü
kaydıyla saklanır. Yeniden başlatılan CLI başka dosyada bu yöntemi kullanır.
Ayrı üretim kontrolü `x*x+1` ifadesini arayarak üretir ve örneklerde olmayan
girdilerle doğrular. Bu sonlu gramer aramasıdır; döngüler, koşullar, çok dosyalı
tasarım ve genel algoritma üretimi henüz bu gramerin parçası değildir.

### Öğrenilmiş yöntemin ölçülen aktarım maliyeti

`node scripts/run-tests.js test/coder-learning-gain.test.js`

Bu eşleştirilmiş kabul testi eğitim bittikten sonra üç yeni dosya, identifier
ve girdi kümesi oluşturur. Her iki kol aynı görev JSON'unu, başlangıç kaynak
metnini ve bağımsız doğrulama dosyasını alır; görev/test hash'leri karşılaştırılır.
Hafızasız kol `--synthesize`, eğitimli kol `--adapt-memory` kullanır. Her görev
için üst sınır sekiz verifier denemesidir. Test dosyası çalıştırıldığında yazılan
bir sayaç, döngü raporundaki deneme sayısını bağımsız olarak kontrol eder.

| Aynı yöntem aktarımı | Hafızasız verifier süreci | Öğrenilmiş verifier süreci |
| --- | ---: | ---: |
| Birinci yeni görev | 4 | 1 |
| İkinci yeni görev | 4 | 1 |
| Üçüncü yeni görev | 4 | 1 |
| Toplam | 12 | 3 |

İlk eğitim dört verifier süreci kullanır. Eğitim de hesaba katıldığında bu
üç görev için öğrenilmiş yolun toplamı yedidir: net beş süreç daha azdır.
Kaynak kod ve mühürlü aday hash'leri değişmez; yeni görevlerin kendi gözlenen
başarı kayıtları açılmış SQLite journal üzerinden doğrulanır.

Farklı yöntem kontrolünde `% 2` hafızası ikinci derece görevi çözemez: test
başarısız olur, dosya geri alınır ve negatif deneyim kaydı oluşur. Aynı görevde
ayrı çağrılan yeni ifade araması başarılı olur. Hafıza reddinden yeni çözüm
araması bu karşılaştırmada ayrı çağrılır; test iki modu açıkça karşılaştırır.

Bu üç sabit, aynı yöntem aktarımında verifier çağrısı tasarrufu kanıtıdır.
Eşit toplam CPU, gecikme veya journal I/O maliyeti; istatistiksel genelleme;
yeni algoritma ailelerinde öğrenme kazancı bu testle ölçülmez.

### Hafızadan yeni aramaya geçiş

`--synthesize` görevinde `synthesis.reuseMemory: true` seçildiğinde sistem önce
mühürlü yöntemleri doğrular ve sayısal örneklere uyan tek yöntemi dener. Yöntem
bulunmazsa doğrudan yeni ifade arar. Birden fazla uygun yöntem veya bozuk kaynak
kaydı varsa işlem durur; belirsizlik aramayla örtülmez.

Öğrenilmiş yöntem bağımsız testte başarısız olur ve dosyanın geri alınması
doğrulanırsa kalan deneme bütçesiyle yeni ifade arar. Yetki reddi, çalıştırılamayan
test veya doğrulanmamış geri alma yeni aramaya izin vermez. İki aşama birlikte
en fazla sekiz aday dener. Daha önce denenen ifade, gereksiz parantezler dahil
aynı sözdizim ağacıyla tekrar denenmez. Kazananın gerçek aşama ve deneyim kaydı
korunur; `rememberFile` verilirse yeni çözüm ancak başarılı testten sonra saklanır.

`test/coder-memory-first-synthesis.test.js` gerçek CLI ve SQLite journal ile
hafıza başarısını, geri alma sonrası yeni aramayı, ortak bütçeyi, belirsizlik ve
bozuk kayıt reddini doğrular. Kuru çalıştırma yalnız yeni arama önizlemesi üretir.
Bu akışın kapsamı hâlâ sınırlı aritmetik ifade grameridir.

### Mevcut projede adı verilen fonksiyon

Görevde `synthesis.functionName` verilirse `--synthesize`, dosyanın tamamının
tek arrow fonksiyonu olmasını istemez. CommonJS import, export ve başka
fonksiyonlar içeren dosyada yalnız seçilen üst düzey
`function NAME(PARAM) { return EXPRESSION; }` bildirimini işler. Parametre ve
dönüş ifadesi mevcut aritmetik gramerinde olmalıdır. Yorumlar dahil ifade
aralığının dışındaki kaynak aynen korunur; başka fonksiyondaki aynı ifade
değiştirilmez. Kaynak yalnız sözdizimi için derlenir, seçim sırasında çalıştırılmaz.

Örneğin `"functionName": "calculate"` ve giriş-çıkış örnekleri yeterlidir;
görev `find` veya `replace` çözüm metni taşımaz. `reuseMemory: true` ile daha
önce doğrulanmış bu tür bir fonksiyon yöntemi, farklı fonksiyon ve parametre
adlarına bağlanabilir. Mühürlü kaynak, qualification ve bağımsız test kapıları
korunur. Fonksiyon bildiriminin tamamı literal değiştirme çapasıdır; öğrenilen
yöntem ifadesi ve hedef fonksiyon bu kapsam içinde birlikte doğrulanır.

Birden fazla aynı adlı bildirim, iç içe hedef, async/generator, birden fazla
parametre veya ifade dışındaki gövde desteklenmez. Regex, template, kaçışlı
identifier ve ESM import içeren kaynak reddedilir. Bu bir genel JavaScript
AST düzenleyicisi veya genel algoritma sentezleyicisi değildir.

`test/coder-named-function-synthesis.test.js` gerçek CLI ile soğuk üretim,
saklama, farklı projedeki adlara aktarım, kaynak bütünlüğü ve başarısız testte
geri alma davranışlarını doğrular.

### Liste örneklerinden döngü üretimi

`synthesis.family: "array-fold"` ve `functionName`, sayısal liste girdilerinden
tek bir `for...of` döngüsünün akümülatör güncellemesini arar. Görev çözüm
metni veya algoritma adı taşımaz. Başlangıç değeri -1, 0 veya 1; ifade
yaprakları akümülatör, mevcut öğe ve 0..3 sabitleridir. En fazla iki
`+`, `-`, `*` veya `%` düğümü birleştirilir. Bu kapsam koşullu dallanma,
min/max, iç içe döngü veya genel amaçlı algoritma üretimi içermez.

En az üç farklı liste örneği ve boş liste örneği gerekir. En fazla 32
örnek, örnek başına 128 eleman ve eleman başına ±1.000.000 güvenli tamsayı
kabul edilir. Kaynak seçim sırasında çalıştırılmaz; desteklenen program
ağacı yorumlanır. Üretilen kaynak mevcut bağımsız test, izinli yol, mühürlü
kayıt ve doğrulanmış geri alma kapılarından geçer. Hafızadan aktarım da
fonksiyon gövdesinin ve yeni isim bağlarının yeniden doğrulanmasını gerektirir.

Kabul testi gerçek CLI'yi ayrı Node sürecinde, temiz feature Git fixture'ı ve
yeniden açılmış SQLite journal ile çalıştırır. Metinler yeni görevde yokken
dosyaya gözlenen etkiyi doğrular; bozuk aday, yanlış workspace, belirsiz hedef,
mevcut dosya ve junction üzerinden kaynak dosyasına yazma girişimi reddedilir.
