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
