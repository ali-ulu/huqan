# Observability Dashboard SSE davranışı

Bu dilim, HUQAN observability dashboard’ındaki canlı event stream için tarayıcı tarafı dayanıklılık sınırını tanımlar. Stream bağlantısı kapanırsa veya HTTP/network hatası oluşursa dashboard bağlantıyı otomatik olarak yeniden açmayı dener; bekleme süresi 1 saniyeden başlar, her başarısız denemede iki katına çıkar ve 15 saniyede sınırlandırılır. Başarılı bir event alındığında retry sayacı sıfırlanır.

Her browser oturumu en fazla 128 stream event kimliği tutar. Server’ın `eventId` alanı varsa duplicate anahtarı olarak kullanılır; yoksa event türü, zaman, run/trace, durum ve tool alanlarından deterministik bir fallback anahtarı türetilir. Aynı anahtar tekrar geldiğinde event log’una yeniden yazılmaz ve observability bulk refresh tetiklenmez. Eski anahtarlar FIFO biçimde atılarak istemci belleğinin sınırsız büyümesi engellenir.

Kullanıcı refresh yaptığında önceki stream abort edilir ve bekleyen reconnect timer’ı temizlenir. Böylece aynı dashboard görünümü için birden fazla açık bağlantı veya stale reconnect döngüsü bırakılmaz. `obsstatus` alanı `role="status"` ve `aria-live="polite"` ile reconnect bekleme durumunu yardımcı teknolojilere duyurur.

Bu PR yalnızca dashboard’ın mevcut authenticated observability stream’ine bağlanan client davranışını ve local deterministic contract testlerini kapsar. Üçüncü taraf notification teslimi, distributed idempotency, server-side event replay, deployment, hosted secret management veya production SLA kanıtı değildir. Stream endpoint’i ve workspace/auth sınırları backend’in mevcut sözleşmesine tabidir.
