# M7 salience: gerçek görev ölçümü ön-kayıt taslağı

Durum: **DRAFT / NOT_MEASURED — henüz kilitlenmiş ön-kayıt değildir.**
İlgili iş: #4065; plan: `docs/cognitive-architecture-plan.md`, §5 ve §7.
Bu belge deney sözleşmesini tanımlar; aşağıdaki kontrollü pilot üretim davranışını değiştirmez.

## Kontrollü pilot sınırı

Pilot giriş noktası `node lib/cognitive-lab-m7-experiment.js` komutudur;
`repair`, `denied` ve `rollback` senaryoları ayrı çalıştırılır. İki kol ayrı
child process, çalışma alanı, Git deposu ve journal ile başlar. Gerçek onay
rezervasyonu, AgentV3 Coder yürütmesi, bağımsız test ve geri alma yolu kullanılır.
Kontrol kolu yalnız mevcut scheduler çağrısındaki urgency değerlerini sıfırlar;
gözlem, puanlama, öğrenme ve güvenlik kapıları çalışmaya devam eder.

Onarım senaryosu, native Coder planındaki tek adımı koruyup güvenli bir `ask`
işiyle yarıştıran **Lab sabit-plan fixture'ıdır**. Bir iterasyon bütçesiyle bu
kurulumun etkisi karakterize edilir. Native tek-adımlı üretim planının sıralama
kazanımı veya genel görev başarısı hakkında çıkarım yapılmaz. Ret ve geri alma
senaryoları native tek-adımlı planla güvenlik sözleşmesini sınar.

Kabul oracle'ı sentez örnekleri ve Coder kabul testindeki girdilerden ayrı
girdilerde gerçek fonksiyon çıktısını sınar. Fresh-process kontrolü, mevcut
journal'dan prediction/outcome çiftlerini ve türetilmiş değeri yeniden okur.
Model ve ağ çağrıları child içinde engellenir; engelin çalışması ayrıca sınanır.
Rapor her durumda `PILOT_ONLY` ve `assertsGain: false` taşır.

Duvar süresi kolun kurulumunu, yürütmesini, oracle'ını ve yeniden açılışını
kapsar; dış orchestrator'ın başlatma/temizlik süresi bu sayıya dahil değildir.
Bellek değeri arm Node süreci ile yeniden açılış Node sürecinin gözlenen tepe
değeridir; Git, bağımsız oracle ve Coder test alt süreçlerinin belleği ölçülmez.
Bu ölçü tüm süreç ağacının toplam/ eşzamanlı tepe belleği olarak sunulmaz.
Pilot testlerinin geçmesi aşağıdaki holdout kilitlerini kapatmaz.

### Gözlenen tek pilot koşusu

2026-10-23, Windows, kaynak `d6615ce606ee243c034edc09c2d98416eac53880`;
`runM7Pilot()` varsayılan `repair` senaryosu. Bu tek elle kurulmuş görevdir;
bağımsız grup örneklemi, holdout veya istatistiksel kazanım değildir.

| Ölçü | Kontrol | M7 |
| --- | --- | --- |
| Ayrı girdilerde gerçek kabul testi | Başarısız | Geçti |
| Kaynak değişti | Hayır | Evet |
| Executor girişi | 1 | 1 |
| Coder kabul testi çağrısı | 0 | 1 |
| Bağımsız oracle çağrısı | 1 | 1 |
| Model / ağ girişimi | 0 / 0 | 0 / 0 |
| Journal çifti / türetilmiş değer girdisi | 0 / 0 | 1 / 1 |
| Kol duvar süresi | 1508 ms | 3304 ms |
| Sınırlı süreç kapsamındaki tepe RSS | 66,265,088 bayt | 87,199,744 bayt |

Süre ve RSS yalnız bu çalıştırmanın gözlemidir; tekrarlı performans kazancı
iddiası değildir. Yukarıdaki alt süreç belleği ve orchestrator maliyeti sınırları
geçerlidir. Sonuç etiketi **PILOT_ONLY**, `assertsGain: false`; nihai Lab sonucu
**NOT_MEASURED** olarak kalır.

## Kaynak sınırı

İncelenen main: `7e262d49e36b8be70c396c24224ec2eea269cb9a`.
Geri bildirim adayı: #4193, `42cfad6b1bfb845ddcdad9f091a45ef1ccc4e16a`.
Bu SHA deney sürümü olarak kilitlenmemiştir; merge sonrası gerçek aday SHA'sı
manifestte ayrıca sabitlenmelidir. Mevcut entegrasyon testleri karakterizasyon
ve G1 pilot kanıtıdır; gerçek engineering görev başarısı veya gain kanıtı değildir.

## Hipotez ve karşılaştırma

H1: Aynı scheduler içinde M7 urgency katkısı, eşit görev başına bütçede bağımsız
doğrulanan görev başarı oranını artırır; eski becerilerde kabul edilen kaybı aşmaz.

- Kontrol: aynı scheduler; M7 urgency katkısı sıfır.
- Aday: aynı scheduler; mevcut M7 urgency katkısı etkin.
- İki kolun izinleri, başlangıç grafı/journal geçmişi, sensörü, gözlem ve öğrenme
  akışı, risk kuralları, starvation/streak durumu ve görev bütçesi aynıdır.
- Her çift ayrı workspace/depo kopyalarıyla aynı başlangıçtan çalışır. Bir kolun
  yazıları diğerine veya sonraki holdout görevine taşınmaz.

`salience:false` veya cognition'ı tümden kapatmak geçerli kontrol değildir:
mevcut seam gözlemi de kapatır. Pilot testi, scheduler girdilerinin yalnız urgency
bakımından değiştiğini sınar; ayrı kol kimlikleri ve bunlardan türetilen scope
hash'leri açıkça normalize edilir. Bu kontrol nihai holdout sözleşmesinin yerini almaz.

## Görev ve başarı sözleşmesi

Her görev; kaynak grubu, başlangıç dosyaları, izinli değişiklik alanı, gerçek
yürütme yolu, bağımsız kabul komutu/postcondition ve bütçeyi önceden içerir.
Yürütme yolu görevin beklenen çıktısını gerçekten değiştirebilmelidir.

Başarı, bütçe sonunda bağımsız kabul denetiminin gerçek görev çıktısını doğrulamasıdır.
Adım kimliği seçimi, kuyruğun sırası, `step.ok`, öz bildirim veya alakasız bir
sentinel dosyanın hash eşleşmesi başarı değildir. Öğrenme sinyalini üreten artifact
beklentisi tek başına holdout kabul oracle'ı olarak kullanılamaz.

Başarısız, zaman/bütçe aşımına uğrayan ve sonucu doğrulanamayan görevler başarı
paydasından çıkarılmaz. Eksik bağımsız sonuç başarı sayılmaz. Görev düzeyinde
bozuk deney kurulumu ayrı raporlanır; sonuç görüldükten sonra sessiz dışlama yapılmaz.

## Bölme ve kilitleme

Train, calibration ve holdout ayrımı dosya/adım kimliğiyle değil bağımsız kaynak
ve görev gruplarıyla yapılır. Aynı projeden türetilen varyantlar aynı grupta kalır.
Eşleşen kaynaklar, kopyalar ve türetmeler bölmeler arasında denetlenir.
Holdout sonuçları görülmeden ayarlar, seed'ler ve değerlendirme sözleşmesi donar.

Mevcut B6 külliyatı ve tarihsel ön-kaydı değiştirilmez. B6'nın çözüm adımı üyeliği
ve steps/solved ölçümü bu deneyin gerçek başarı ve toplam maliyet ölçümü değildir.
Manifest v2, `computeManifestDigest` ve eşli örnekleme/kontrat kilidi yaklaşımı
yeniden kullanılabilir; grup bağımsızlığı ayrıca doğrulanmalıdır.

## Ölçüler ve bütünlük

Birincil ölçü bağımsız görev başarı oranının eşli kol farkıdır. Hata oranı ve
doğrulanamayan sonuçlar ayrı gösterilir. Belirsizlik hesabının birimi bağımsız
kaynak/görev grubudur; varyantlar bağımsız örnek gibi sayılmaz.

Her görev/kol için gerçekleşen araç ve model çağrıları, duvar saati, bellek ve
bakım/öğrenme maliyeti kaydedilir. Modelsiz koşuda model çağrısı sıfır olmalıdır;
Uçtan uca ölçüm sınırı; kopya kurulumu, graf açılışı/yeniden açılışı ve bağımsız
kabul denetiminin maliyetini içerip içermediğiyle birlikte önceden kilitlenir.
B6'nın varsayımsal çağrı sayaçları kopyalanmaz. İki kola aynı görev başına limitler
uygulanır; yalnız külliyat toplamı eşitliği yeterli değildir.

Fresh-process yeniden açılış, değişmiş ortam ve eski beceri görevleri ayrı
tabakalar olarak raporlanır. Tekrar eden algı, çelişkili sonuç, eksik sensör,
yanıltıcı yüksek urgency ve starvation anti-vakaları sonuçtan önce seçilir.
Anti-vakada adayın mutlaka kaybetmesi şart koşulmaz; güvenlik ve doğruluk denetlenir.

Yetki bypass'ı, workspace/scope sızıntısı veya yanlış tamamlandı bildirimi
**REJECT** sonucudur; ortalama başarı artışı bunları telafi etmez.
Gözlem bağlantısını ve yeniden sıralamayı kaldıran mutasyonlar ilgili kapıyı
başarısız kılmalıdır. Karakterizasyon mutasyonları holdout gain yerine geçmez.

## Holdout öncesi açık kilitler

Aşağıdakiler doldurulup sürüm kontrollü manifest digest'i alınmadan holdout
başlatılmaz ve bu belge tamamlanmış ön-kayıt olarak sunulmaz:

| Kilit | Mevcut durum |
| --- | --- |
| Aday ve kontrolün değişmez kaynak SHA'ları | Açık |
| Yalnız urgency farkını kanıtlayan kontrol testi | Pilot testi mevcut; nihai evaluator kilidi açık |
| Gerçek görev corpus'u, kaynak grupları ve içerik digest'leri | Açık |
| Train/calibration/holdout grup listeleri ve sızıntı denetimi | Açık |
| Holdout'ta donmuş politika veya yalnız görev içi geçmişten çevrimiçi uyarlama seçimi | Açık |
| Bağımsız kabul oracle'ları ve yetkili yürütme yolları | Açık |
| Görev başına bütçeler, seed'ler ve durdurma kuralları | Açık |
| Asgari anlamlı etki, güç gerekçesi ve bağımsız grup sayısı | Açık |
| Eski beceri non-inferiority sınırı ve maliyet kabul sınırları | Açık |
| Belirsizlik yöntemi, karar eşikleri ve evaluator sürümü | Açık |

Küçük pilot yalnız kurulum ve maliyet tahmini içindir; pilot sonuçları gain sayılmaz.
Nihai örnek sayısı mevcut küçük test sayılarından türetilmez. Eşikler veya corpus
değişirse yeni ön-kayıt sürümü gerekir; eski holdout kalibrasyon verisine dönüşür.

Karar etiketleri: şu an **NOT_MEASURED**. Kurulum/örnek yetersizse **INSUFFICIENT**;
geçerli deneyde kazanım gösterilmezse **MEASURED_NO_GAIN**; yalnız önceden
kilitlenmiş başarı, maliyet ve non-inferiority kapıları birlikte geçerse **GAIN**.
Bütünlük ihlalinde **REJECT**. Hiçbiri kendiliğinden üretim varsayılanını değiştirmez.
