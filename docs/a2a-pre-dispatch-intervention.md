# A2A gönderim öncesi müdahale sınırı — R22

`require('huqan').createA2aHandoffDispatcher(options)` host uygulamasının
giden bounded-exchange mesajını değerlendiren public SDK sınırıdır. Sıra:
`intervention → prepare → verify → admission → karar makbuzu → dispatch → sonuç makbuzu`.

Host mevcut Graph örneğini, workspace/ajan kimliğini, policy sürümünü ve beş
callback'i sağlar. Otomatik transport veya varsayılan imza doğrulayıcısı yoktur.
`prepare` hostun mevcut imzalama ve kanıt bağlama akışını çalıştırır;
`verify` kriptografik doğrulamayı, `admission` güncel yerel policy kontrolünü
yapar. Son iki callback açık `allow` kararı ve gerekçe döndürmelidir.

`intervention` sonucu `allow`, `drop` veya `modify` olabilir. `modify` yalnız
parametre hashini değiştirir, riski/izin listelerini/sona erme süresini daraltır;
workspace, ajanlar, capability, hedef, tool ve connector değişemez. Hazırlanan
mesajın değerlendirilen eylem ve kimlik alanları tekrar karşılaştırılır. İmza ve
kanıtlar yeniden bağlanır; eski imzayla değişmiş içerik gönderilmez.

Kararlar mevcut `trust_evidence` ailesi ve Graph mutation journal üzerinden
kalıcılaşır. Makbuz yazılamazsa dispatch çağrılmaz. `drop` bir block makbuzu
bırakır; makbuz yalnız sınırlı kimlik referanslarını ve mesaj hashlerini taşır.
Exchange kimliği tekrar kullanılırsa, eşzamanlı çağrıda veya yeniden başlatmada
ikinci gönderim yapılmaz. Aynı kimlikle değişmiş mesaj identity conflict olur.

`dispatched / transport_returned`, transport callback'inin geçerli JSON yanıtı
döndürdüğünü bildirir. Alıcının kabulünü veya yan etkinin tamamlandığını kanıtlamaz.
Transport hatası, timeout veya geçersiz yanıt `unknown / delivery_unknown` olur.
Sonuç makbuzu yazılamazsa `delivery_receipt_failed` görünür; rezervasyon korunur.
Replay yanıtı `previousOutcome`, `deliveryRecorded` ve varsa `outcomeReceipt`
taşır. Eksik sonuç makbuzu, izinli rezervasyon için `delivery_unknown` demektir.
Host callback'leri AbortSignal'i dikkate almalıdır; timeout uzak etkileri geri alamaz.

Doğrulama: `test/a2a-pre-dispatch-intervention.test.js` public export'tan gerçek
Graph kalıcılığına ve imzaları yeniden bağlanan gerçek yerel A2A alıcısına ulaşır.
Negatif testler kapsam genişletme, gizli getter, hata/timeout, admission reddi,
makbuz arızası ve tekrar gönderimi kapsar. `node scripts/a2a-intervention-mutation.js`
müdahale çağrısı devreden çıkarıldığında reddetme testinin kırıldığını doğrular;
kaynak dosyasını değiştirmez. Harici A2A uygulamalarıyla uyumluluk ayrıca ölçülmelidir.
