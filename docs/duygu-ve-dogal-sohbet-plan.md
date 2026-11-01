# HUQAN duygu döngüsü ve doğal sohbet uygulama planı

Tarih: 2026-10-29. Son güncelleme: 2026-11-01.
Durum: A ve B teslim edildi; C altyapısı teslim edildi (PR-1 #4446, PR-2 #4447, PR-3 #4453); D'nin Laya kapanış denetimi teslim edildi (karar STAY_SHADOW); C'nin ölçümü ile D'nin kalan adımları ve E–F açık ve izleniyor. Planlama ve issue/Project bağları tamamlandı; uygulama, eğitim ve kazanım kanıtı yalnızca ilgili alt işlerde aranır.
Kaynak taban: ali-ulu/huqan main `fed7be80c075d45c6d73b98af7f9cffa9111eff6`.
COG ana program: #4060. Bu plan mevcut mimari sözleşmenin yerine geçmez.
Kapsam onayı: duygu motoru ve doğal sohbeti planlamak, belgelemek, GitHub Project ve issue bağlarını kurmak. Runtime kodu/eğitim/model indirme bu teslimde yoktur.

## GitHub iş ağacı ve bağımlılıklar
Üst plan: https://github.com/ali-ulu/huqan/issues/4390
COG Project: https://github.com/users/ali-ulu/projects/7

| İş | Issue | Durum | Teslimat / bağlantı | Önkoşul / ilişkili işler |
| --- | --- | --- | --- | --- |
| A — Çekirdek ve gerçek gözlem | #4391 | Kapandı | PR-1 #4437, PR-2 #4441 | M1 #4064, M2 #4061, M8 #4062, M9 #4063 tekrar kullanılır |
| B — Sorumluluk ve onarım | #4392 | Kapandı | PR-1 #4442, PR-2 #4443, PR-3 #4444 | A #4391 |
| C — Konuşma/hafıza girişi | #4393 | Altyapı teslim | PR-1 #4446 (saf sözleşme), PR-2 #4447 (workspace'e bağlı yüzey), PR-3 #4453 (mevcut `/answer` ve proxy girişlerine ince adapter) | A #4391 ve B #4392 ile sözleşme uyumu; kalan: G2 ölçümü (F #4396) |
| D — Laya/yorumlayıcı | #4394 | Kapanış denetimi teslim | `docs/audits/laya-closure-audit-20261101.md` (karar: STAY_SHADOW) | C #4393 şeması; kalan: ONNX/Node paritesi, lisans ve daha büyük holdout |
| E — Yerel üretken sohbet | #4395 | Açık | — | C #4393 ve D #4394'teki tek hat/kapanış kararı |
| F — Birleşik ölçüm | #4396 | Açık | — | A–E; #4387 M7 düzeltmesi ve #4388 M9 ölçümüyle koordinasyon |

A–F bu planın iş paketi adlarıdır; yeni COG M-modülü numarası değildir. Kapalı modül issue'ları yeniden açılmaz. #4387/#4388 bu epic'in altına taşınmaz; mevcut COG sahipliği korunur. Yeni işler başlangıçta Todo ve NOT_MEASURED'dır; bağımlı işler ayrıca Bağımlılık bekliyor olarak işaretlenir. Henüz kodu olmayan plan kartlarına bağlama durumu verilmez. Bu plan kendisi bir uygulama teslimatı değildir; gerçek bağlama ve ölçüm durumu yukarıdaki alt işlerde ve COG Project'te izlenir.

## Amaç ve başarı tanımı
HUQAN'ın olaylardan türetilen iç durumunun konuşma, hafızadan geri çağırma ve izinli eylem önerileriyle nedensel olarak birleşmesi. Başarı; duygu kelimesi üretmesi değil, geçmiş olayın sonraki gerçek seçimde ölçülebilir iz bırakması ve doğrulanmış onarım sonrasında durumun uygun güncellenmesidir. Öznel yaşantı veya insanın duygusunu kesin bilme iddiası yapılmaz.

## Gözlenen taban ve mevcut işlerle ilişki
- M1 #4064: gözlenen/bildirilen/türetilmiş ayrımı ve kaynak bağı.
- M2 #4061, M8 #4062: tahmin hatası ve bağımsız gözlenmiş ödül. Yeniden yazılmaz.
- M9 #4063 kapalıdır; değer/valans/arousal defteri kullanılır. Sonuç `docs/task-packs/cog-m9-value-ledger-result-20261029.md` kontrollü fikstürdür, `assertsGain:false`. Gerçek M9 corpus/ölçüm boşluğu #4388'de takip edilir; yeni kopya açılmaz.
- M7 #4065'in tüketilmiş holdout sonucu HARM: 103/384 aday, 128/384 kontrol. #4381 kaynak bağlı zarar incelemesini, #4387 düzeltme ve YENİ cohort işini izler. Bu sonuç tüm duygu/arousal etkilerinin ayrı nedensel kanıtı değildir.
- M5 #4068: mevcut Sistem 2 tavsiye/gerçek yürütme kapısı. Duygu çekirdeği eylem yetkisi kazanmaz.
- M3 #4069, M4 #4070, M11 #4066: tekrar, unutma ve çalışma belleğiyle uyum; yeni ikinci kalıcılık otoritesi yok. M11 kalıcı konuşma/ilişki hafızası yerine geçmez.
- M6 #4067 ve açık PR #4374; gerçek Coder gözlemi PR #4389 ile olası dosya çakışmaları uygulama öncesi tekrar kontrol edilir. Paralel değişiklikler kopyalanmaz.
- `/answer` şablonlu doğrulama cevabı, `/v1/chat/completions` dış modele aktarıcıdır. Tam HUQAN konuşma döngüsü yoktur.
- Laya-v1 eğitim sonuçları ayrı ali-ulu/huqan-decision-engine deposunda `af8b953cbcb649e4ddef97456315d78c2f66281e`: BEV accuracy 0.6594; 13 çiftlik R51 kapısında ECE/FPR başarısız. Gölge mod sürer. Laya sınıflandırıcıdır, üretken sohbet modeli değildir. ONNX/Node paritesi ve saf JS runtime uygulanabilirliği yeni kanıt gerektirir.

## Değişmezler
1. Core saf ve deterministik JS: I/O, saat, rastgelelik ve runtime dış model çağrısı yok. Zaman ve kaynak sınırları adapter'dan gelir.
2. Tek kalıcılık otoritesi mevcut journal; türetilmiş cache replay ile eşdeğer. Yeni olay sözleşmesi gerekiyorsa sürümlü, sınırlandırılmış ve eski kayıtlarla uyumlu olur.
3. Workspace, frame, run, decision, step ve Coder workKind ayrımları korunur; geniş bir risk-family anahtarı kişisel ilişki/onarım kimliği sayılmaz.
4. Duygu firewall/risk/trust/onay girdisi olamaz; sabit doğrulama tabanını düşüremez. Ek yük yalnız izinli öneri/iş planı düzeyinde sınanır.
5. Kullanıcının kızması başarısızlık, övmesi başarı kanıtı değildir. Kullanıcı duygusu ile HUQAN durumu ayrı nesnelerdir.
6. Model parametreleri başlangıçta çevrimdışı öğrenilir, dondurulur ve sürümlenir. Runtime'da journal'a bağlı durum değişir. Çevrimiçi parametre öğrenmesi ayrı gelecek kararıdır.
7. Aynı `asOf/historyBoundary` altında eski snapshot değişmez. Yeni onarım, yeni olaydır; geçmişe bilgi taşımaz.
8. Bayraksız davranış korunur; opt-in ve yeni bağımsız ölçüm olmadan varsayılan terfi yok.
9. Kullanıcı mesajları/duygu bildirimleri için saklama tercihi, erişim, silme ve yeniden türetme politikası belirlenmeden kalıcı kayıt açılmaz. Ham metin append-only journal'a körlemesine gömülmez; erişilemeyen/silinmiş kaynak replay'de geri doğmaz.

## A — Duygu çekirdeği ve gerçek gözlem bağlantısı
Girdiler: hedefe etki, beklenmediklik, belirsizlik, sorumluluk ve kontrol için kaynak bağlı kanıt. Bilinmeyenler `unknown`; belirsizliği sayısal kesinliğe dönüştürme yok.
Memnuniyet/şaşkınlık ilk adaylar; pişmanlık kendi katkısı ve daha iyi alternatif desteği ister. Kaygı/engellenme için gerekli gelecek hedef/beklenti girdileri ayrıca kurulmadan etiket uydurulmaz. Sabitler önceden belgelenir; fizyolojik eşik icat edilmez.
Çıktı: türetme sürümü, kaynak sınırı/digest, destek, boyutlar, gerekçeli etiket veya abstention; SIGNAL_ONLY.
Öngörülen dosyalar: yeni `lib/cognition/appraisal.js`; `lib/cognition/cognition-config.js`, `lib/cognition-value-ledger-pairs.js`, `lib/agent-cognition-seam.js`. Ledger okuma kuralları paylaşılacaksa mevcut sonuç değişmeden karakterizasyonla kilitlenir.
Testler: yeni `test/cognition-appraisal.test.js`, `test/cognition-appraisal-runtime.test.js`; mevcut config/purity/reward/value-ledger/seam testleri.
Kabul: gerçek file-effect/Coder olayından durum; eksik kaynakta abstention; future/duplicate/cross-workspace karşı örnekleri; süreç yeniden açıldığında aynı replay; bayrak kapalıyken eski davranış. İlk dilimde kuyruk değişmez.
Boyut M; gerekirse çekirdek ve gerçek bağlantı ayrı PR, biri diğerinin yerine tamamlandı sayılmaz.

## B — Sorumluluk, belirli hataya bağlı onarım ve durum sürekliliği
`agent_executed` yalnız yürütme bilgisidir; `agent_caused` değildir. Journal'da bulunmayan sorumluluk/kontrol bilgisi varsayılmaz. Atıf için kabul edilebilir kanıt türleri ve ihtilaf/unknown yolları açık sözleşmeye bağlanır.
Onarım olayında belirli kaynak hata/decision/artefact referansı ve bağımsız doğrulama bulunur. Aynı ailede sonraki confirmed eski hatayı kapatamaz; ajan kendi beyanıyla onarımını doğrulayamaz.
Yoğunluk zamanla azalabilir; çözülmemiş sorun kaydı ve sorumluluk durumu bununla silinmez. Ek kontrol yükünün kapatılması onarım kanıtı ister, taban korunur.
Öngörülen yüzeyler: `lib/agent-cognition-observation.js`, `lib/prediction-outcome-pairs.js`, mevcut journal/admission sözleşmeleri ve A çekirdeği. Alanların gerçekten taşınabildiği uygulama keşfinde doğrulanır; sahte şema ismi verilmez.
Kabul: yanlış onarım bağı, dış süreç etkisi, ilgisiz başarı, çift onarım, eski snapshot ve restart karşı örnekleri; kanıtsız pişmanlık üretmeme.
Boyut M/L; A'ya bağlı.

## C — Konuşma oturumu, hafıza bağlamı ve geri bildirim girişi
Workspace'e bağlı conversation/session/message kimliği, sıra/idempotency, reply-to ve ilgili decision/repair referansı. Mesaj içeriği talimat/yetki değil güvenilmeyen veridir.
İlgili geçmişi izinli memory/admission yoluyla seç; bağlam bütçesi, kaynak etiketleri ve kullanıcıya gösterilen silme/saklama seçenekleri belirle. Başka workspace veya oturumdan bağlam sızmasın.
Açık kullanıcı bildirimi bile reported; alıntı, olumsuzlama, ironi ve olay belirsizliğinde açıklama isteme. İlk sürümde yapılandırılmış bildirim veya kullanıcının doğruladığı olay bağlantısı tercih edilir.
Öngörülen tekrar kullanım: memory-cognitive-message/admission, agent-memory-runtime ve HTTP route sözleşmeleri; `lib/http/answer-route.js`, `lib/llm-proxy/proxy-handler.js` mevcut davranışı korunarak gerçek yeni conversation servisine ince adapter gerekebilir. Kesin route/UI dosyaları uygulama keşfinde dondurulur; yeni rota varsa auth, http-contracts, api snapshot, ownership ve package closure birlikte teslim edilir.
Kabul: gerçek dispatcher üzerinden iki konuşma turu, restart, iptal/yeniden deneme, saklama kapalı, silme sonrası geri çağırmama, tenant izolasyonu; kızgınlık -> otomatik olumsuz ödül dönüşümü olmaması.
Boyut L; A/B sözleşmeleriyle birlikte tasarlanabilir, üretken model gerektirmeyen API/controlled response testi yapılabilir. Bu test doğal sohbet kazanımı diye sunulmaz.

## D — Laya kapanış denetimi ve Türkçe yorumlayıcı distillation
Önce mevcut Laya denemesi: checkpoint/revision/hash, kalibrasyon, recall/FPR, bağımsız veri, ONNX/Node eşdeğerliği ve runtime kural uyumu. Başarısızsa STAY_SHADOW sonucu açık kaydedilir; eğitimi başarılı ilan etmek için kapı gevşetilmez. Başarı beklenerek iş sonsuza uzatılmaz.
Qwen/Qwen3.5-4B ve 9B öğretmen adayları; önce insan etiketli Türkçe çok turlu ironi/alıntı/öfke/başarı/sorumluluk/unknown setinde karşılaştırılır. Öğretmen kopyasıyla değerlendirme döngüsü kurulmaz; konuşma/kaynak gruplarıyla bölünmüş insan holdout'u ayrıdır.
HuggingBay alternatif indirme kaynağıdır. Kayıtlarında hosted ağırlık bulunması çalışan tam paket kanıtı değildir. Upstream sabit revision, lisans ve her dosyanın hash'i doğrulanmadan veri/eğitim kullanılmaz.
Laya'nın mevcut BEV göreviyle appraisal uyumu ölçülmeden etiket alanı eklenmez. Yeni 0.8B paralel eğitim hattı açılmaz. Uygun değilse tek öğrenci hattı için ayrı karar kaydedilir; otomatik mimari değişikliği yok.
Kabul: öğretmen seçimi gerekçesi, lisans/veri kaynağı ve sızıntı denetimi; sınıf bazlı metrikler, kalibrasyon/abstention/kapsam, mevcut görevlerde non-inferiority, CPU bellek/gecikme ve JS parity. Sayısal hedefler sonuç açılmadan pilot/power gerekçesiyle dondurulur.
Boyut L; C şemasına ve mevcut Laya denemesinin resmi sonucuna bağlı.

## E — Kendi ağırlıklarıyla doğal yanıt üretimi
Laya bu işi yapmaz. Üretken model, tokenizer, inference ve donanım bütçesi ayrı fizibilite kapısıdır. Saf JS/kendi ağırlıkları şartıyla çalışabilirlik gerçek makinede ölçülür; ONNX export tek başına kabul edilmez. Uygulanamazsa FEASIBILITY_BLOCKED raporu verilir, runtime yasağı sessizce değiştirilmez.
Model yalnız doğrulanmış bağlam ve türetilmiş HUQAN durumundan ifade üretir. Önerilen/yürütülen/doğrulanan iş ayrımı yanıt ve eylem akışında korunur; metindeki 'üzgünüm' iç durumun kanıtı değildir.
Kabul: gerçek conversation dispatcher, model yükleme/yanıt/iptal/timeout/OOM/restart; dış modele ağ çağrısı olmadan CPU/RAM/gecikme/token bütçesi; state-response uyumu, duygu uydurmama ve prompt injection/tenant izolasyonu. Kontrollü şablon ve proxy tam yerel sohbet diye sunulmaz.
Boyut L; C ve Laya kapanış denetimine bağlı, D'nin şema sözleşmesini tüketir. D/E veri ve eğitimleri ikinci paralel hat oluşturmayacak biçimde sıralanır.

## F — Birleşik davranış etkisi ve G1/G2/G3
A/B/C/D/E teslimleri tek başına kazanım değildir. Deney kolları: taban, yalnız gözlem, duygu durumunu tüketen izinli davranış; yorumlayıcı/üretken model katkısı ablation ile ayrılır. Aynı bütçe/temel model/veri kullanılır.
Ana ölçüler: tekrarlanan hata, doğrulanmış onarım, sonraki gerçek seçim, görev başarısı. Ek ölçüler: gereksiz kontrol, kullanıcı duygu yorumu hatası, gecikme/bellek/model maliyeti, abstention ve eski becerilerde non-inferiority.
Antivakalar: haksız eleştiri/övgü, ilgisiz başarı, dış süreç etkisi, yanlış onarım bağı, yüksek memnuniyetle doğrulamayı atlama, dağılım değişimi ve süreç restart.
Yeni bağımsız cohort, kaynak/konuşma grubu ayrımı, ön-kayıt, örnek gücü/CI ve dondurulmuş parametreler gerekir. #4387/#4388 ile ölçüm altyapısı paylaşılabilir; tüketilmiş G1 holdout tekrar kullanılamaz, M9 corpus'u tek başına sohbet benchmark'ı değildir.
G1 gerçek sonuç -> sonraki seçim -> restart; G2 mevcut yetki/onay/firewall/yürütme zinciri; G3 maliyet ve non-inferiority birlikte. Gain yoksa HARM/NOT_CLEARED/INSUFFICIENT dürüst raporlanır; varsayılan ayrı karardır.
Boyut L; deney ön-kaydı A'dan sonra hazırlanabilir, nihai ölçüm ilgili bağlantılardan sonra yapılır.

## Sıra ve yayın koşulu
A -> B; C tasarımı A/B ile paralel olabilir. Mevcut Laya denetimi -> D -> E eğitim sırası; C+E ile gerçek sohbet. F ön-kaydı erkenden, veri açılımı en son. A/B üretimi Laya model başarısını beklemez.
Uygulama öncesi güncel main/PR/Project tekrar kontrol edilir; kaynak grafı yerel oluşturulur, sahiplik ve dosya kapsamı dar görevde dondurulur.
İlgili testler: cognition config/purity/agent-seam/reward/value-ledger; yeni appraisal/repair/conversation testleri; sonra lint, check:layers, check:module-boundary, check:package-closure, check:file-size ve tam npm test. HTTP eklenirse API/auth sözleşme testleri de zorunlu.
Bir dilimin kapanışı kaynak SHA, gerçek ingress testi, restart kanıtı ve dürüst bağlı/ölçüldü ayrımı ister. Planın GitHub'a yazılması bu kapıların geçtiği anlamına gelmez.

## En zayıf noktalar ve sınırlar
1. Nedensel sorumluluk ve karşı-olgusal alternatifler mevcut kimlik alanlarından çıkmıyor; yanlış kesinlik üretme riski.
2. Türkçe öğretmen ve BEV öğrencisinin görev uyumu ölçülmedi; distillation öğretmen hatalarını aktarabilir.
3. Kendi ağırlıklarıyla saf JS üretken sohbet için bellek/gecikme/inference uygunluğu kanıtlanmadı.
Duygu eşikleri keyfi biyolojik iddia olmayacak; kontrollü fikstür gerçek kazanım diye sunulmayacak. Fizyoloji/sensör, yeni harici runtime bağımlılığı, ayrı kalıcı duygu deposu, online ağırlık güncelleme, varsayılan terfi ve güvenlik eşiği gevşetme kapsam dışıdır.
