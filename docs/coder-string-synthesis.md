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

Bu ilk metin ailesinde `reuseMemory: true` ve `rememberFile` açıkça
`SYNTHESIS_STRING_MEMORY_UNSUPPORTED` ile reddedilir. Sayısal ailelerin mevcut
bellek yolu korunur. Metin yöntemlerini süreçler arası öğrenme ve aktarma bu
değişiklikle tamamlanmış sayılmaz. Çok hedefli ve pipeline kipleri bu yeni
aileyi henüz kabul etmez.

Kontrol: `node --test test/coder-string-synthesis.test.js`.
