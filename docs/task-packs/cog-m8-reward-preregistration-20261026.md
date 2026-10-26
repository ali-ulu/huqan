# M8 ödül karakterizasyonu: ölçüm öncesi kayıt

İlgili iş: #4062. Kapsam: kontrollü karakterizasyon; genel kazanım deneyi değildir.
Bu belge yeni karakterizasyon testi çalıştırılmadan önce ayrı imzalı commit ile
sabitlenir. Sonuçlar bu ön-kayıt metnine sonradan eklenmez; test/CI çıktısı ve
ilgili PR üzerinden raporlanır.

## Kaynak ve kapsam

- Başlangıç kaynak SHA: `d9be709c50006151175e5f04d4d5edeb818d9f7e`.
- B1 kaynak fixture: `test/cognitive-lab-b1-replay.test.js`; Git blob:
  `ac52b23756da4068558c70ce5a3d63022a24de87`.
- Yeni test: `test/cognition-reward-characterization.test.js`.
- Mevcut M8 ödül çekirdeği, prediction/outcome okuyucusu ve M9 değer okuyucusu
  kullanılır. Üretim kodu, ödül tablosu, model, varsayılan veya eşik değişmez.

B1 fixture'ındaki confirmed, incident, censored ve eksik sonuç sınıfları ile
reported gözlem ayrımı yeniden kullanılır. Bu çalışma B1 replay koşusu değildir.
Eski B1 runner'ın modelCalls bütçesi gerçek çağrı sayacı olarak yorumlanmaz;
bu yerel test model çağrısı gerektirmez. Diğer adlandırılmış ödüller açık sabit
beklentilerle ayrıca sınanır; beklenen değer üretim tablosundan hesaplanmaz.

## Önceden belirlenen kabul koşulları

1. Önsel beklenti sıfırken confirmed için ödül/RPE +1, incident için -1 olur.
   Censored, eksik ve yalnız reported kanıt başarı ödülüne dönüşmez.
2. Reviewer rejection, rollback ve contradiction -1; compensation -0.5;
   uygun olumlu/olumsuz deneyim +1/-1 üretir. Beklenti yoksa `prior` açık kalır.
3. Sıfır olmayan beklentide oracle `clamp(reward - expected, -2, 2)` olur.
   Örneğin reward=-0.5 ve expected=-1 için RPE +0.5'tir; RPE işaretinin her
   zaman sonuç sınıfının işaretine eşit olduğu iddia edilmez.
4. M9 beklentisi yalnız karar öncesinde erişilebilir geçmişten okunur. Kendi
   sonucu, gelecek sonuç ve sonradan kaydedilmiş geriye tarihli sonuç beklentiye
   sızamaz. Workspace ve kaynak erişilebilirliği sınırları korunur.
5. Yetersiz veya ortak kaynağa bağımlı geçmiş ölçülmüş beklenti sayılmaz;
   `expectedFor` null döndürür ve M8 önselini kullanır.
6. Okuyucular kaynak journal'ını değiştirmez; aynı kayıtlar aynı sonucu verir.

Tüm açık oracle kontrolleri geçmelidir; tek bir uyumsuzluk karakterizasyonu
başarısız sayar. Tekrarlar ve elle ayrılmış kaynak grupları bağımsız gerçek
görev örneklemi değildir. Örnek sayısından istatistiksel kazanım çıkarılmaz.

## Doğrulama ve iddia sınırı

Yeni dosya için `node --test test/cognition-reward-characterization.test.js`;
mevcut reward-signal, value-ledger ve value-ledger-pairs testleriyle regresyon;
import-cycle kontrolü, lint ve `git diff --check` çalıştırılır.

Geçen test, bu sınırlı ödül/önsel/veri sızıntısı sözleşmesini gösterir. M8'in
tam RPE çıktısının üretim kararında kullanıldığını, M9 kazanımını, genel öğrenme
başarısını veya G1/G3 kapanışını kanıtlamaz. #4062 kapanışı ayrıca canlı issue
kabul koşullarına göre değerlendirilir.

## Ayrı kapsam: gerçek ajan geri bildirim bağlantısı

Bu ek, yukarıdaki karakterizasyon ön-kaydını değiştirmez ve yeni bir kazanım
ön-kaydı değildir. Bağlantı kapsamı `lib/agent-cognition-seam.js` ve
`test/cognition-reward-runtime.test.js` ile sınırlıdır.

`predictionError + reward` opt-in akışında `beginStepCognition`, gözlemden önce aynı
workspace/frame journal kesitinden M9 beklentisini hesaplar. Bu beklenti özel,
tek kullanımlık pending referansına bağlanır. Geri bildirim izindeki
`rewardHistory`, karar kimliği ve tarih sınırını, önceden görülen kararları,
workspace ve frame hash'ini taşır. Sonradan eklenen sonuçlar beklentiyi değiştirmez.
Ödül gözlemi M7 salience zamanlayıcısının açılmasını gerektirmez; opt-in yokken
mevcut kapalı davranış korunur.

`observeStepCognition`, yalnız mevcut sensörün gerçekten bağlanmış ve yeniden
oynatılmamış sonucundan `computeRewardSignal` üretir. Çıktı mevcut izde `reward`
alanındadır; geçmiş eksik/bozuksa veya pending/gözlem/bağlam eşleşmiyorsa ABSTAIN
olur. Boş ya da yetersiz bağımsız geçmiş açıkça etiketlenmiş sıfır önselini
kullanır. Raporlanan `ok`, tek başına ödül değildir.

Kontroller gerçek dosya sensörü, mevcut journal yazıcısı, AgentV3 döngüsü ve
yeni süreçte geçmişin yeniden okunmasını kapsar. Kaynak geçmiş kayıtları
değiştirilmez; yalnız mevcut prediction/outcome kayıtları eklenir. Yeni depo,
model, yetki, ödül tablosu, varsayılan veya seçim eşiği eklenmez. RPE izinin
oluşması; ödülle yeni davranış öğrenildiğini, Coder kapasitesi artışını veya
genel görev kazanımını kanıtlamaz.
