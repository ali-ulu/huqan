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
onun özgün aday dosyası yeniden kullanılabilir. Bu dilim farklı hedef yola
aktarımı, otomatik yöntem aramasını, genel yazılım üretimini veya ölçülmüş
öğrenme kazancını sağlamaz. B4 doğrulayıcı sonucunun `REJECT` olması değişmez.

Kabul testi gerçek CLI'yi ayrı Node sürecinde, temiz feature Git fixture'ı ve
yeniden açılmış SQLite journal ile çalıştırır. Metinler yeni görevde yokken
dosyaya gözlenen etkiyi doğrular; bozuk aday, yanlış workspace, belirsiz hedef,
mevcut dosya ve junction üzerinden kaynak dosyasına yazma girişimi reddedilir.
