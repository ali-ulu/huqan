# AgentV3 üzerinden onaylı, modelsiz Coder yürütme

Bu bağlantı yalnız host tarafından açıkça kurulunca etkinleşir. Varsayılan plan
ve internal tool listesi değişmez. Coder, `ask` veya `verify` adı altında dosya
yazmaz; plan ve raporda kendi `coder` kimliğini kullanır.

## Host sözleşmesi

Host, temiz ve ayrı feature branch üzerindeki gerçek Git kökünü, workspace'i,
hedefi ve sınırlı görevi seçer. `buildAgentCoderAction` bu kökün canonical yolu,
branch, HEAD, goal ve task içeriğini onay eyleminin args digest'ine bağlar.
Görev mevcut `replace_text` ailesinden olmalı ve bağımsız test komutu taşımalıdır.
Sentez örnekleri içeren görevler mevcut modelsiz `runArithmeticSynthesis` yolunu;
diğer görevler mevcut `runFixLoop` yolunu kullanır.

Çok dosyalı üretim için kapalı görev biçimi
`{ id, operation: { type: 'initialize_project', targetRoot, spec, projectMemory? } }`
kullanılır. `root` temiz kaynak Git deposudur; `targetRoot` ayrı, boş ve başka bir
Git deposunun dışında olmalıdır. Genel `sequence` veya `create_file` görevleri bu
bağlantıyla yetki kazanmaz. Kaynak HEAD'i, hedef, üretilen görev özeti ve varsa
belleğin canonical yolu/içerik özeti aynı onaya bağlanır; yürütmeden önce yeniden
doğrulanır. Spec onay zarfında JSON metni olarak tutulur; mevcut derinlik sınırı
değişmez.

Proje görevi mevcut initializer, bağımsız HTTP kabul testi ve tüm çıktıların
rollback yolunu kullanır. İsteğe bağlı tek `projectMemory` dosyası için journal
host tarafından sağlanır. Başarılı, mühürlü yöntem mevcut biçimde kaydedilir veya
yeniden doğrulanıp kullanılır. Bellek yazımı kısmen başarısızsa görev tamamlandı
sayılmaz; sonuç uzlaşma gerektirir ve kalan kuyruk yürütülmez. Bu bağlantı bellek
havuzu veya bellek üzerine yazma yetkisi eklemez.

Host mevcut Human Oversight Runtime'da bu eylem için review case oluşturup gerçek
operatör kararını alır. Sonra AgentV3 kurucusuna `coderExecution` verir:
`{ root, task, goal, action, caseId, approvalRuntime, requesterContext, journal? }`.
`action`, helper'ın ürettiği eylemle aynı olmalıdır. `requesterContext` receiver'ın
kimlik çözümleyicisine aittir; kuyruk veya görev içeriği kimlik sağlayamaz.
`policyVersion` ve `firewallVersion` gerçek host politikasını göstermelidir.

Bu kurucu ayarı yalnız eşleşen goal/workspace için bir Coder adımı üretir.
Run seçeneklerine veya task içine `coderExecution` / `authorized:true` eklemek
yürütme portu kurmaz. Görev ve eylem yapılandırması kopyalanıp dondurulur.

## Yürütme sınırı

Mevcut emergency stop, goal binding, before-task plugin, davranış bütünlüğü ve
action firewall kontrolleri korunur. Yerel dosya hedefi host tarafından kurulan
adımda `internal` sınıfını taşır; hedef yolunun kendisi onay kapsamına bağlıdır.

Hazırlık; exact adım girdisi, workspace, goal, canonical Git kökü, branch/HEAD,
temiz depo ve gerçek kalıcı onayı doğrular. AAFW yalnız tam `coder/code_change`
sınıflamasını, açık host onayıyla mevcut code-change gate'e devreder. Bu sınıflama
tek başına yürütme izni değildir; bilinmeyen başka araçlara allowlist eklenmez.
Secret, otomasyon tehlikesi, preview/dry-run, kirli depo ve politika tabanları
normal kapı zincirinden geçer.

`executeApprovedSync`, mevcut async yürütmeyle aynı authorize/reserve/outcome
mantığını paylaşır. Kalıcı tek kullanımlık rezervasyon Coder'dan önce yazılır.
Kapsam rezervasyondan sonra tekrar doğrulanır; ancak bu executor içinde mevcut
Coder'a `authorized:true` aktarılır. Code-change gate bir BLOCK kararını operatör
onayıyla düşüremez; bağımsız test başarısızsa mevcut rollback uygulanır.
Onay; retry, resume veya yeni süreçte ikinci kez dosya yazma iznine dönüşmez.

Senkron executor Promise/thenable döndürür veya sonucu belirsizleşirse uzlaşma
gerekir. Başlamış asenkron yan etki iptal edilmiş veya başarıyla bitmiş sayılmaz.

## Öğrenme ve kanıt sınırı

Host cognition bayraklarını ve dosya beklentisini ayrıca kurduğunda mevcut sensör,
Coder öncesi/sonrası gerçek artifact'i gözler. `step.ok` bağımsız sonuç yerine
geçmez. Onaylı dosyanın beklenen SHA'sı, görevin anlamsal doğruluğuyla aynı iddia
değildir; görev başarısı bağımsız kabul testiyle değerlendirilir.

Opsiyonel Coder journal'ı host sağlar; journal ve çalışma dosyaları temiz kaynak
deposunun dışında veya önceden ignore edilmiş yerde tutulmalıdır. Mevcut task
öğrenme/remember ayarları ve qualification kapıları aynen geçerlidir; bağlantı
kendiliğinden kalıcı yöntem kaydetmez veya yeni bellek deposu oluşturmaz.

Entegrasyon testi gerçek AgentV3 planı, onay, sentez, dosya değişikliği, ayrı kabul
girdileri, artifact gözlemi ve fresh-process journal okumasını doğrular. Bu bir
test ortamı kanıtıdır. Holdout başarısı, toplam maliyet veya genel kazanım iddiası
değildir; M7 deney protokolünün açık kilitleri ayrıca tamamlanmalıdır.

## Mühürlü yerel kabul sonucu gözlemi

Host, cognition bayrakları ve scheduler yanında açıkça
`cognitionCoderExpectations[stepId] = { workspaceId, expected: 'passed', sourceGroup, riskScore }`
bildirirse `initialize_project` kabul sonucu mevcut journal'dan salt okunur gözlenir.
`riskScore` mevcut 0–100 risk birimindedir; eksik değer bilinmeyen kalır.
Aynı adımda dosya beklentisiyle birlikte bildirim belirsizdir ve gözlem kurulmaz.
Diğer Coder görev türleri bu bağlantı kapsamında değildir.

Alıcı görev/onay/HEAD/workspace bağını kendi kapalı kapsamından kurar. Yalnız
kendi yürüttüğü sonuç nesnesini kabul eder; rapor klonu veya `step.ok` kanıt olmaz.
Boş, göreve özgü run kimliği yürütmeden önce ayrılır. Kapalı journal'ın görev,
operasyon ve dosya özetleri, nedensel zinciri ve gerçek kabul komutu doğrulanır.
Başarılı kabul `confirmed`; exit 1/TEST_FAILED ve doğrulanmış rollback
`contradiction` olur. İkinci sonuç yalnız kabul testinin başarısızlığıdır:
journal'ın genel `unknown` işlem sonucu değiştirilmez.

Denial, eksik/bozuk/açık journal, timeout/signal, kısmi veya belirsiz sonuç,
yanlış kapsam ve değiştirilmiş HEAD gözlenmiş başarı oluşturmaz. Mevcut onay,
bağımsız test, rollback ve varsayılan kapalı cognition davranışı korunur.
Sonuç mevcut prediction/outcome deposuna yazılır; yeni depo veya yöntem terfisi yoktur.
Yerel regresyon: `node --test test/cognition-coder-outcome-runtime.test.js`.
