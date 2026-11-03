# Modelsiz string dizisi sentezi

`coder <task.json> --synthesize --authorize --root <repo>` mevcut Coder
yürütme, bağımsız kabul testi ve rollback hattını kullanır. Yeni aile
`string-array-join`, örneklerden iki kapalı program arasında seçim yapar:
doğrudan birleştirme veya ilk görülme sırasını koruyarak tekrarları kaldırma
ve birleştirme. Bu, grammar'ın kendiliğinden öğrenilmesi değildir.

## Görev sözleşmesi

```json
{
  "id": "unique-methods",
  "level": "l0",
  "allowedPaths": ["router.js"],
  "operation": {"type": "replace_text", "path": "router.js"},
  "test": {"command": "node test/router.acceptance.js"},
  "synthesis": {
    "family": "string-array-join",
    "target": {"binding": "options", "separator": ","},
    "examples": [
      {"input": [], "output": ""},
      {"input": ["GET", "GET", "POST"], "output": "GET,POST"},
      {"input": ["POST", "GET", "POST"], "output": "POST,GET"}
    ]
  }
}
```

Görev hazır replacement veya program içermez. Ayraç aranmaz; seçicideki
literal kaynak ifadesiyle aynı olmalıdır. İsteğe bağlı `target.sourceHash`,
işlem öncesi kaynak dosyasının UTF-8 SHA-256 özetidir. Özet değişirse yazılmaz.
En az üç, en fazla 32 farklı giriş örneği gerekir. Girdiler en fazla 128
elemanlı yoğun string dizileridir; her string en fazla 1024 UTF-16 birimidir.
Ayraç en fazla 64 birimdir. Çelişkili örnekler veya tek programın seçilememesi
aday üretmez; zaten sağlanan örnekler de değişiklik gerektirmez.

## Kaynak seçimi ve güvenlik sınırı

Acorn yalnız ayrıştırır; kaynak dosya okuyucu tarafından çalıştırılmaz.
Kaynak en fazla 128 KiB ve ayrıştırma/gezinme en fazla 40.000 token/düğümdür.
Tam dosyada seçili binding'in çevreleyen bildirimi veya fonksiyon parametresi
bulunmalıdır. Yöntem uyarlamasında tek başına ifade parçası da okunabilir.
Bu statik kontrol çalışma anındaki değerlerin string dizisi olduğunu kanıtlamaz;
ayrı kabul testi gerçek bağlamı sınamalıdır.

Yalnız bir `identifier.join(stringLiteral)` ifadesi veya bu ailenin tam
canonical çıktısı seçilir. Birden çok hedef, computed/optional çağrı, dinamik
ayraç, `with`, doğrudan `eval`, bozuk kaynak ve desteklenmeyen seçici reddedilir.
Regex, yorum veya template içindeki benzer metin hedef sayılmaz. Üretilmiş ES5
ifade, `Set` veya `Array` global isimlerine bağımlı değildir. Yalnız seçilen
ifadenin baytları değişir; mevcut Coder kaynak/işlem doğrulamaları korunur.

## Kayıt ve yeniden kullanım

`synthesis.rememberFile`, mevcut aday deposunda bir dosya yolu belirtebilir;
`synthesis.reuseMemory: true` mevcut mühürlü yöntem seçimini kullanır.
Kayıt için gerçek bağımsız kabul testi, uygun mühürlü kaynak ve mevcut
qualification kapıları gerekir. Başarısız testten yöntem kaydedilmez.

Seçicinin binding ve ayraç bilgisi aday özetine bağlanır; çalışma anında kaynak
yeniden okunur ve uyarlama yeniden türetilir. Bu ilk dilimde binding/ayraç
değiştirilerek aktarım desteklenmez. Değiştirilmiş aday veya seçici yazmadan
reddedilir. Başarılı bellek kullanımında sonlu arama yapılmaz (`enumerated: 0`);
kabul testi yine çalışır. Test başarısızlığı mevcut rollback davranışını korur.

## Doğrulama ve iddia sınırı

Program ve hedef testleri, gerçek CLI kabul/ret/rollback testleri ve yeni süreçte
bellek kullanımı ayrı doğrulanır. Express 4.10.6'nın sabit buggy kaynağı üzerinde
izole qualification, gerçek OPTIONS yanıtındaki yinelenen yöntemleri sınar;
bu yerel çalışma npm paketindeki otomatik test corpus'u değildir.

Bu aile tek başına üç bağımsız sealed support, canonical M3 replay kabulü,
24+8 bağımsız değerlendirme ailesi veya M3/G3 kazanımı sağlamaz. Express daha
önce görülmüş qualification örneğidir; bağımsız ve görülmemiş holdout sayılmaz.
Varsayılanlar, yetki kapıları, terfi politikası ve sürüm değişmez.

## Uygulama dosyaları

- Program ve okuyucu: `lib/experience/string-array-program.js`,
  `lib/experience/string-array-target.js`.
- Planlama ve bellek: `lib/coder/string-array-synthesis.js`,
  `lib/coder/arithmetic-synthesis.js`, `lib/coder/synthesis-memory.js`,
  `lib/coder/learned-candidate.js`, `lib/experience/expression-adaptation.js`,
  `lib/experience/coder-routing-runtime.js`.
- Testler: `test/string-array-program.test.js`,
  `test/string-array-target.test.js`, `test/coder-string-array-synthesis.test.js`,
  `test/coder-string-array-learning.test.js`.
- Paket ve kayıtlar: `package.json`, `package-lock.json`,
  `scripts/context-ownership.json`, `config/reachability-baseline.json`,
  `coverage-manifest.json` ve bu belge.
