# HUQAN Product Hunt Quickstart ve Demo Rehberi

Bu rehber, HUQAN’ı Product Hunt ziyaretçisine **beş dakika içinde denettirmek** ve yaklaşık iki dakikalık bir ürün walkthrough’u kaydetmek için hazırlanmıştır. Akış, repository’nin gerçek local-first CLI, REST server, authenticated observability API’si ve Trust Command Center UI’si üzerine kuruludur.

> HUQAN bir LLM veya hosted SaaS değildir. Bu rehber, local-first bir agent observability ve governance MVP’sini gösterir. Demo, production ölçek, bağımsız third-party interoperability veya production SLA kanıtı olarak sunulmamalıdır.

## Ne gösterilecek?

Demo iki gerçek ürün yüzeyini art arda gösterir. İlk bölümde `quickstart` komutu, mutating `learn` isteğinin review ve approval sonrasında doğrulanabilir Trust Receipt’e dönüşmesini gösterir. İkinci bölümde gerçek AgentV3 çalışması yapılandırılmışsa bu run’ın Observability sekmesindeki metrics, Run History, tool usage, alert, queue ve live event stream yüzeylerine nasıl taşındığı gösterilir.

Tek komutlu demo gerçek AgentV3 akışını izole bir SQLite veritabanında çalıştırır; sentetik telemetry veya mock dashboard kullanmaz. Kişisel memory, mevcut proje verisi ve ortam API anahtarları demo verisine kopyalanmaz.

| Akış | Ne gösterir? | Veri davranışı |
|---|---|---|
| Trust Receipt quickstart | Review gate, operator approval, verification ve canonical receipt | Throwaway store; kullanıcının memory’sine yazmaz |
| Gerçek AgentV3 run | Run History, tool usage, metrics, alert, queue ve SSE olayları | Kullanıcının seçtiği local SQLite DB’sine gerçek runtime telemetry’si yazar |
| Dashboard read surface | Workspace-scoped ve redacted observability görünümü | Ham goal/prompt/output veya secret göstermez |

## Gereksinimler

Node.js **22.13.0 veya daha yeni** bir sürüm, npm ve Git gerekir. Kaynaktan çalıştırma için repository clone’u ve `npm ci` kullanılır. `better-sqlite3` yüklenemezse platformun derleme araçları gerekebilir.

Demo için gerçek API anahtarı kullanmayın. Aşağıdaki `ph-local-demo-key` yalnızca localhost üzerinde ve geçici demo DB’siyle kullanılacak örnek bir anahtardır. Anahtarı repository’ye, ekran görüntüsüne veya Product Hunt açıklamasına koymayın.

## 1. Kaynaktan kurulumu yapın

```bash
git clone https://github.com/ali-ulu/huqan.git
cd huqan
npm ci
```

Kurulumun ve temel runtime’ın doğru olduğunu kontrol etmek için:

```bash
node --version
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('SQLite OK')"
```

Published npm paketi kullanılacaksa `npm install -g huqan` ve `huqan quickstart` çalışır. Product demo’sunda kullanılacak en güncel observability davranışı için repository’nin güncel `main` branch’ini veya güncel paket release’ini kullandığınızı doğrulayın.

## 2. İlk Trust Receipt’i gösterin

Repository kökünde:

```bash
node cli.js quickstart
```

Published paket ile:

```bash
npx -y huqan quickstart
```

Beklenen çıktı biçimi şöyledir; UUID değerleri her çalıştırmada değişir:

```text
HUQAN quickstart — learn -> review -> approve -> verify -> Trust Receipt
  1. OK   propose: huqan.learn -> review (mutating_requires_review), approval approval-<uuid>
  2. OK   approve: huqan.approve -> approved (actor cli-quickstart)
  3. OK   verify: verified (confidence 0.90)
  4. OK   receipt: receiptId <uuid> (status canonical)

Trust Receipt
  receiptId          : <uuid>
  claim              : smoking
  status             : canonical
  workspaceId        : default
  trustPolicyVersion : 0.8.0
  provenance         : mcp.huqan.learn.approval-<uuid>
  auditTrail entries : 1
Demo store (throwaway, removed after the run; your own memory was not touched): /tmp/huqan-quickstart-<id>
```

Bu adımın anlatımı şudur: HUQAN mutating `learn` isteğini doğrudan yazmaz; önce `review` kararı ve approval kaydı üretir, operator approval sonrasında canonical write yapar, ardından graph üzerinden verify eder ve Trust Receipt oluşturur. Gate gevşetilmez. Quickstart geçici store kullandığı için Product Hunt videosunda “your own memory was not touched” satırını özellikle gösterin.

## 3. İzole demo server’ını başlatın

Repository kökünde tek komut çalıştırın:

```bash
npm run demo:observability
```

Komut boş bir `.huqan-observability-demo` klasörü oluşturur, bounded bir gerçek AgentV3 run’ı üretir ve server’ı başlatır. Çıktıda dashboard adresi, sabit `huqan-observability-demo` workspace’i ve yalnızca bu process için rastgele oluşturulmuş session API key gösterilir. Bu değerleri Settings ekranına girin. Varsayılan adres:

```text
http://127.0.0.1:3000
```

Demo klasörü doluysa komut mevcut veriyi ezmez ve fail-closed çıkar. Başka bir klasör veya port için `node scripts/observability-demo.js --output <bos-klasor> --port <port>` kullanın. Server başlatmadan yalnızca kanıt üretmek için `--no-serve` ekleyin.

## 4. Gerçek bir AgentV3 run’ı gönderin

Tarayıcıda **Settings** sekmesine gidin ve şu değerleri girin:

| Alan | Değer |
|---|---|
| API Key | `ph-local-demo-key` |
| Workspace | `product-hunt-demo` |

**Kaydet & Bağlan** düğmesine bastıktan sonra **Observability** sekmesine geçin. Queue panelindeki **Goal** alanına kişisel veri içermeyen, kısa ve güvenli bir hedef yazın. Örneğin:

```text
Verify a bounded local claim and report its evidence status
```

`Max steps` değerini `2` veya `3` seçip **Kuyruğa al** düğmesine basın. UI önce `queue_enqueued` olayını ve queue durumunu gösterir. Worker yapılandırması uygunsa iş `queue_started` durumuna geçer; AgentV3 run’ı tamamlandığında Run History, metrics ve Tool Usage Mix güncellenir. Worker başarısız olursa failure status, error code, retry count ve canlı olay akışı yine monitoring değerini gösterir.

## 5. Observability ekranında gösterilecek yüzeyler

Run oluştuğunda aşağıdaki sırayı izleyin. Sayısal değerler ortam ve run’a göre değişir; rehber sabit success rate, latency veya tool count vaat etmez.

| Sıra | Dashboard yüzeyi | Gösterilecek nokta |
|---:|---|---|
| 1 | Metrics kartları | Total Runs, Completed/Failed Runs, Success Rate, Average/P95 Latency, Tokens, Cost ve Queue Depth |
| 2 | Tool Usage Mix | Gerçek run step’lerinden türetilen araç dağılımı, toplam çağrı ve yüzde |
| 3 | Run History | Workspace kapsamındaki run status, süre, step bilgisi, benzersiz tool listesi ve çağrı sayısı |
| 4 | Live Event Stream | `run_started`, step, queue ve `run_finished` olaylarının SSE üzerinden redacted akışı |
| 5 | Agent Queue | queued/running/failed status, retry ve lease davranışı |
| 6 | Alert Rule | Dashboard formundan seçilen threshold ve cooldown ile üretilecek alarm durumu |

Canlı olaylar için Observability sekmesi SSE bağlantısı açar. Bağlantı kurulumu veya yeniden bağlanma durumunu gösterirken, tarayıcı ağ panelinde API key’i veya hassas request payload’ını kaydetmeyin.

## 6. Alarmı göstermek

Dashboard’daki **Alert Rule** formundan bir eşik seçin. Product demo için mevcut run’ın ölçülen değerine göre bir eşik belirleyin; örneğin gerçek p95 latency değerinin hemen altında bir `p95_latency_ms` eşiği veya gözlenen queue depth’in üzerinde olmayan bir queue kuralı seçebilirsiniz. Eşik değerini önceden sabitlemeyin; çünkü run süresi ve queue zamanlaması makineye göre değişir.

Alarm gösterimi sırasında rule adı, metric, threshold, actual value, firing/resolved status ve cooldown alanlarını göstermek yeterlidir. Aynı olayın cooldown nedeniyle tekrar tekrar alarm üretmemesi beklenen davranıştır. Notification adapter’ı yapılandırılmadıysa dashboard alarmı, harici Slack/e-posta gönderimi anlamına gelmez.

## 7. İki dakikalık Product Hunt demo senaryosu

Aşağıdaki akış ekran kaydı veya canlı walkthrough için kullanılabilir. Toplam süre yaklaşık 90–120 saniyedir.

| Süre | Ekran ve hareket | Söylenecek ana mesaj |
|---:|---|---|
| 0–10 sn | HUQAN başlığı ve local terminal | “AI agent’ınızın ne yaptığı, hangi araçları kullandığı ve ne kadar sürdüğü görünür olsun.” |
| 10–25 sn | `node cli.js quickstart` çıktısı | “HUQAN, mutating write’ı review ve operator approval olmadan canonical memory’ye geçirmiyor; sonunda doğrulanabilir Trust Receipt üretiyor.” |
| 25–40 sn | Trust Command Center → Settings → Observability | İzole workspace’e authenticated biçimde bağlanın. |
| 40–55 sn | Metrics kartları | Gerçek run’ın başarı, gecikme, token, cost ve queue sinyallerini gösterin. |
| 55–70 sn | Tool Usage Mix ve Run History | Gerçekte kullanılan araçların dağılımını, çağrı sayılarını ve run status’unu gösterin. |
| 70–85 sn | Live Event Stream | Bir queue veya run olayının redacted SSE akışında görünmesini gösterin. |
| 85–105 sn | Agent Queue ve Alert Rule | Queue state, lease/retry veya threshold tabanlı alarm görünümünü gösterin. |
| 105–120 sn | Dashboard genel görünüm ve güvenlik notu | “Read modelleri workspace-scoped’dir; ham goal/prompt/output veya secret gösterilmez.” diyerek kapatın. |

### Product Hunt için kısa İngilizce anlatım

> **HUQAN makes AI-agent behavior observable without turning your data into a cloud dependency.** Start with a real review-gated Trust Receipt, then open the local command center to inspect run history, tool usage, latency, token cost, alerts, live events, and queue state — all scoped to the selected workspace.

> The demo uses isolated local data. Metrics and run results come from the configured local runtime; the walkthrough does not claim production scale, hosted SaaS availability, or an external integration that has not been configured.

## 8. API ile hızlı doğrulama

Dashboard yerine terminalden aynı yüzeyleri kontrol etmek için server çalışırken:

```bash
curl -fsS \
  -H "Authorization: Bearer $HUQAN_API_KEY" \
  "http://127.0.0.1:3000/api/observability/metrics?workspaceId=$DEMO_WORKSPACE&windowMs=86400000"
```

Run geçmişi:

```bash
curl -fsS \
  -H "Authorization: Bearer $HUQAN_API_KEY" \
  "http://127.0.0.1:3000/api/observability/runs?workspaceId=$DEMO_WORKSPACE&limit=10"
```

Alarm geçmişi:

```bash
curl -fsS \
  -H "Authorization: Bearer $HUQAN_API_KEY" \
  "http://127.0.0.1:3000/api/observability/alerts?workspaceId=$DEMO_WORKSPACE&limit=10"
```

Run oluşmadan metrics sonucu boş değerler veya `null` oranlar içerebilir; bu, local server’ın henüz telemetry almadığını gösterir. API key vermeden yapılan istek `401 Unauthorized` döndürmelidir. Farklı workspace ile yapılan istek, `product-hunt-demo` verisini döndürmemelidir.

## 9. Kayıt ve görsel hazırlığı

Ekran kaydı sırasında yalnızca localhost adresi ve geçici demo API key’i kullanın. Rastgele UUID’leri kısaltabilirsiniz; ancak `review`, `approved`, `verified`, `canonical`, workspace kapsamı, tool count, status ve alarm threshold değerlerini doğru biçimde gösterin. Bunlar ürünün değerini anlatan güvenli sinyallerdir.

Önerilen görsel seti dört kareden oluşur: Trust Receipt quickstart çıktısı, gerçek run’ın metrics kartları, Tool Usage Mix + Run History ve Live Event Stream + Queue/Alert paneli. Hiçbir karede ham prompt, tool input/output, secret, credential veya kişisel veri görünmemelidir.

## 10. Troubleshooting

| Belirti | Çözüm |
|---|---|
| `better-sqlite3` yüklenemiyor | Node.js 22.13+ kullandığınızı ve platform derleme araçlarının kurulu olduğunu kontrol edin; sonra `npm ci` çalıştırın. |
| Dashboard `401 Unauthorized` gösteriyor | Settings’te API key’in server’daki `HUQAN_API_KEY` ile aynı olduğunu kontrol edin. |
| Dashboard boş görünüyor | Workspace’in tam olarak `product-hunt-demo` olduğunu, server’ın `$DEMO_DB` ile başlatıldığını ve en az bir gerçek run veya queue job gönderildiğini kontrol edin. |
| Queue job çalışmıyor | Worker’ın `HUQAN_AGENT_WORKER_ENABLED=1` olduğunu ve AgentV3 runtime/araç yapılandırmasının mevcut olduğunu kontrol edin. Yapılandırılmamış runtime’da failure/retry beklenebilir. |
| `400` ve workspace hatası | Observability GET istekleri tam olarak bir adet boş olmayan `workspaceId` ister. |
| SSE olay görünmüyor | Settings bağlantısını yenileyin, doğru workspace’i seçin ve yeni bir queue/run olayı üretin. |
| Alarm görünmüyor | Eşiği gerçek ölçüme göre seçin; cooldown süresi içinde aynı rule için ikinci firing bastırılabilir. |
| Port dolu | `PORT=3001` gibi başka bir port seçin ve dashboard’u yeni porttan açın. |
| Quickstart kendi memory’sini değiştirdi sanılıyor | `quickstart` throwaway store kullanır; çıktıda `your own memory was not touched` satırını kontrol edin. |

## 11. Temizlik

Server terminalinde `Ctrl+C` ile yalnızca bu demo server’ını durdurun. Sonra geçici DB’yi silin:

```bash
rm -f "$DEMO_DIR/memory.db" "$DEMO_DIR/memory.db-wal" "$DEMO_DIR/memory.db-shm" "$DEMO_DIR/memory.json"
rmdir "$DEMO_DIR" 2>/dev/null || true
```

Bu komut yalnızca rehberde oluşturduğunuz geçici demo klasörünü hedeflemelidir. Gerçek HUQAN memory veya başka bir proje DB’si üzerinde çalıştırmayın.

## Gerçeklik sınırı

Bu rehberin kanıtladığı şey, local-first monitoring MVP’sinin kurulabilir ve gözlemlenebilir demo akışıdır: gerçek CLI quickstart, authenticated server bağlantısı, workspace-scoped metrics/events/runs/queue/alerts yüzeyleri ve redacted SSE akışı. Bu rehber tek başına hosted SaaS deployment’ı, çok kiracılı production işletimi, belirli bir ölçek/SLA veya üçüncü taraf agent framework entegrasyonu kanıtlamaz.

Product Hunt metninde en doğru ifade **local-first agent observability MVP / open-source beta** olacaktır. Hosted auth, RBAC, retention, rate limiting, backup/restore, notification adapter’ları, load/soak kanıtı ve operasyonel SLO’lar sonraki ürünleşme aşamasının konularıdır.
