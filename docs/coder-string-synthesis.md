# Modelsiz metin fonksiyonu sentezi

`coder request.json --synthesize --authorize --root <repo> --json` mevcut bir
JavaScript/CommonJS fonksiyonunun metin dönüşümünü giriş/çıkış örneklerinden
üretebilir. Bu, sayısal sentez dışındaki sınırlı bir program ailesidir;
serbest doğal dil anlayışı veya genel programlama başarısı değildir.

```json
{
  "id": "normalize-label",
  "level": "l0",
  "allowedPaths": ["text.js"],
  "operation": { "type": "replace_text", "path": "text.js" },
  "test": { "command": "node acceptance.js" },
  "synthesis": {
    "family": "string-expression",
    "functionName": "clean",
    "examples": [
      { "input": " ABC ", "expected": "abc" },
      { "input": " MiXeD ", "expected": "mixed" },
      { "input": "", "expected": "" }
    ]
  }
}
```

Hedefin desteklenen başlangıç biçimi örneğin
`function clean(value) { return value.toUpperCase(); }` ve CommonJS export'udur.
Adı verilen tek parametreli fonksiyon mevcut kaynak okuyucusuyla bulunur.
Gövde yalnız parametrenin kendisini veya desteklenen yöntem zincirini döndürür.
Rastgele çağrılar, dinamik özellik erişimi, döngüler ve diğer gövdeler reddedilir.
Hedef kod ayrıştırma veya aday seçimi sırasında çalıştırılmaz.

Arama, en fazla üç aşama ve 12 sabit işlem kullanır: `trim()`, `toLowerCase()`,
`toUpperCase()`, `slice(1/2/3/-1/-2/-3)` ve `slice(0,1/2/3)`. Boş zincirle
birlikte 1.885 program değerlendirilir. Daha kısa zincir önce gelir; aynı
uzunlukta sabit işlem sırası kullanılır. En çok sekiz eşleşme denenmek üzere
saklanır. `matchingPrograms`, `omittedCandidates`, `enumerated` ve `searchBudget`
sayılır; sekiz aday ötesinde eksiksiz çözüm arandığı iddia edilmez.

Üç ile 32 arasında, girişleri birbirinden farklı eğitim örneği gerekir.
Girdi, çıktı ve ara değerler en çok 1.024 JavaScript UTF-16 kod birimli metindir.
Harf dönüşümü JavaScript'in yerel ayardan bağımsız yöntemlerini kullanır;
`slice` UTF-16 konumlarını izler, grafem bölütleme yapmaz. Kullanıcının işlem,
yerine yazılacak kaynak veya çalıştırılacak ifade sağlaması gerekmez.

Eğitim uyumu yalnız aday üretir. Bağımsız `test.command` yeni girdilerde gerçek
fonksiyonu sınamalıdır. Mevcut yetki kapısı ve ortak sekiz deneme bütçesi
uygulanır. Başarısız kabul testi yamanın geri alınmasını gerektirir; bağımsız
test seçimi değiştiren eğitim girdisine dönüştürülmez. İşlem gözlemleri gerçek
zaman veya toplam öğrenme maliyeti ölçümü değildir.

## Doğrulanmış yöntemi öğrenme ve aktarma

Bir journal ile `synthesis.rememberFile`, yalnız bağımsız testten geçen ve
saklanan değişikliği mevcut kaynak mühürlü aday belleğine kaydeder. Örneğin
`.huqan/coder/candidates/string.json` kullanılabilir. İki negatif kaynak
eşleşme fikstürü `qualificationPaths` ile verilir; mevcut doğrulama kapısı
kapsama uygunluğunu ayrıca sınar. Başarısız veya yetkisiz koşum kayıt üretmez.

`synthesis.reuseMemory: true`, kaydedilmiş yöntemin kaynak mühürlerini ve
programını doğrular, yeni dosyanın eski programıyla eşleştirir, fonksiyon ve
parametre adlarını bağlar ve yeni eğitim örneklerinde kapalı AST'yi sınar.
Hedefteki başlangıç işlem zinciri kaynak başlangıcıyla aynı olmalıdır; yalnız
adların ve biçimin değişmesi desteklenir. Bağımsız kabul testi ve normal
yetki kapısı yeniden uygulanır. Başarılı yeniden kullanım `enumerated: 0`
bildirir; bu yalnız yeni aday enumerasyonudur, toplam CPU/süre maliyeti değildir.
Kaynak kaydı değiştirilmez; yeni bir `rememberFile` verilse de çoğaltılmaz.

Bağımsız kabulde başarısız olan bellek adayı ancak doğrulanmış rollback sonrası
yeni aramaya geçebilir. Bellek denemesi aynı sekiz aday bütçesinden düşer;
bütçe birse durur. Başarısız zincirin canonical AST'si yeni adaylardan çıkarılır.
Kaynak veya kayıt bütünlüğü bozulduğunda yeni aramaya düşülmez. Aynı eğitim
örneklerine uyan farklı zincirlerin varlığı, genel öğrenme başarısı veya
genel aktarım başarısı olarak yorumlanmaz. Çok hedefli ve pipeline kipleri
bu metin ailesini henüz kabul etmez; eski sayısal bellek yolu korunur.

Kontrol: `node --test test/coder-string-synthesis.test.js`.
Öğrenme/aktarım kontrolü: `node --test test/coder-string-learning.test.js`.
