# Observability Dashboard time-window davranışı

Observability görünümü, metrics ve run history sorgularını seçilen bir zaman penceresiyle yeniler. Seçenekler son saat, son 24 saat, son 7 gün ve son 31 gündür. Varsayılan pencere son 24 saattir. Her sorgu mevcut dashboard workspace kimliğini taşır; başka workspace verisi istemci filtresiyle değil, backend workspace scope’u ile dışarıda bırakılır.

Metrics endpoint’i seçilen `windowMs` değerini toplam run, success rate, latency, token, cost ve tool-usage agregasyonlarına uygular. Runs endpoint’i aynı pencereyi `updated_at` üzerinden uygular ve mevcut bounded cursor/limit pagination davranışını korur. Queue depth ve active alerts mevcut bounded workspace snapshot’ları olarak kalır; bu dilim onları tarihsel arşiv sorgusuna dönüştürmez.

Backend yalnızca 1 saniye ile 31 gün arasındaki güvenli pencereyi kabul eder; eksik veya kullanılamaz değerler bounded varsayılan pencereye düşer, üst sınır aşımı 31 güne kırpılır. OpenAPI v1 tanımı runs `windowMs` parametresini metrics ile aynı integer aralığında ilan eder.

Bu dilim tarihsel event pagination, queue/alert arşivleme, distributed analytics, deployment, hosted SaaS davranışı veya production SLA kanıtı değildir. Dashboard yalnızca mevcut authenticated observability read surface’lerine istek yapar; üçüncü taraf notification veya dış sistem çağrısı eklemez.
