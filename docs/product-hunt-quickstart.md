# HUQAN Product Hunt Quickstart ve Demo Rehberi

Bu rehber, HUQAN’ı Product Hunt ziyaretçisine **beş dakika içinde denettirmek** ve yaklaşık iki dakikalık bir ürün walkthrough’u kaydetmek için hazırlanmıştır. Akış, mevcut local-first CLI, REST server, authenticated observability API’si ve Trust Command Center UI’siyle çalışır.

> HUQAN bir LLM veya hosted SaaS değildir. Bu rehber, local-first bir agent observability ve governance MVP’sini gösterir. Product Hunt metninde demo verisini production ölçek, bağımsız third-party interoperability veya production SLA kanıtı olarak sunmayın.

## Demo iki ayrı akıştan oluşur

İlk akış, HUQAN’ın Trust Receipt değerini tek komutla gösterir. `huqan quickstart` kendi geçici store’unu kullanır; gerçek `learn -> review -> approve -> verify -> Trust Receipt` zincirini çalıştırır, fakat kullanıcının canonical memory’sini değiştirmez.

İkinci akış, Observability sekmesinin değerini gösterir. Deterministik demo script’i aynı SQLite DB’ye iki güvenli örnek run, tool usage, token/cost, bir alarm kuralı ve isteğe bağlı queue kaydı yazar. Server bu DB’yi açar ve dashboard bu veriyi authenticated API üzerinden gösterir. Bu iki akış bilerek ayrıdır: quickstart Trust Receipt üretir; observability seed’i dashboard’u doldurur.

| Akış | Ne gösterir? | Veri davranışı |
|---|---|---|
| Trust Receipt quickstart | Review gate, operator approval, verification ve canonical receipt | Throwaway store; kullanıcının memory’sine yazmaz |
| Observability dashboard demo | Run History, tool usage, metrics, alert ve queue | Seçilen demo SQLite DB’sine kontrollü örnek veri yazar |
| İsteğe bağlı worker | Gerçek AgentV3 queue execution | Yalnız yapılandırılmış runtime ile; başarı garanti edilmez |

## Gereksinimler

Node.js **22.13.0 veya daha yeni** bir sürüm, npm ve Git gerekir. Kaynaktan çalıştırma için repository clone’u ve `npm ci` kullanılır. `better-sqlite3` yüklenemezse platformun derleme araçları gerekebilir.

Bu demo için gerçek API anahtarı kullanmayın. Rehberdeki `ph-local-demo-key` yalnızca localhost üzerinde, geçici demo DB’siyle kullanılacak örnek bir anahtardır. Anahtarı repository’ye, ekran görüntüsüne veya Product Hunt açıklamasına koymayın.

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

Published npm paketi kullanılacaksa `npm install -g huqan` ve `huqan quickstart` çalışır. Product Hunt observability demo script’i belirli bir release’e henüz dahil değilse kaynak checkout akışını kullanın; en güncel demo dosyası repository’deki `scripts/product-hunt-observability-demo.js` dosyasıdır.

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
Demo store (throwaway, your own memory was not touched): /tmp/huqan-quickstart-<id>
```

Bu adımın anlatımı şudur: HUQAN mutating `learn` isteğini doğrudan yazmaz; önce `review` kararı ve approval kaydı üretir, operator approval sonrasında canonical write yapar, ardından graph üzerinden verify eder ve Trust Receipt oluşturur. Gate’i gevşetmez. Quickstart geçici store kullandığı için Product Hunt videosunda “your own memory was not touched” satırını özellikle gösterin.

## 3. Deterministik observability demo DB’sini hazırlayın

İkinci terminalde veya aynı terminalde aşağıdaki komutları çalıştırın. `DEMO_DIR` yalnızca bu demo için ayrılmış geçici klasördür:

```bash
export DEMO_DIR="$(mktemp -d)"
export DEMO_DB="$DEMO_DIR/memory.db"
export DEMO_WORKSPACE="product-hunt-demo"

npm run demo:observability -- \
  --db "$DEMO_DB" \
  --workspace "$DEMO_WORKSPACE" \
  --reset \
  --no-queue
```

Beklenen özet:

```text
HUQAN Product Hunt observability demo data ready.
  database  : /tmp/<id>/memory.db
  workspace : product-hunt-demo
  runs      : 2 (1 completed, 1 failed)
  tool calls: 4
  queue     : 0 queued/running
  alerts    : 1 firing
  note      : demo goals are stored privately; public projections expose digest and length only.
```

Bu script iki temsilî run oluşturur: biri completed, diğeri kontrollü bir `DEMO_REVIEW_REQUIRED` failure durumundadır. Tool Usage Mix içinde `verify: 2`, `ask: 1` ve `compare: 1` görünür. p95 latency alarmı 500 ms eşiğini aşacak şekilde firing olur. Amaç gerçek performans ölçümü yapmak değil, dashboard’un başarı, hata, tool mix, cost, token ve alert yüzeylerini tek ekranda görünür kılmaktır.

`--no-queue` başlangıçta queue’yu boş bırakır. Canlı stream’i göstermek için dashboard açıldıktan sonra UI içindeki Agent Queue formundan bir demo goal gönderin. Worker kapalı olduğu için bu job kuyrukta kalır ve `queue_enqueued` olayı SSE akışında görünür. Böylece canlı akış ve queue görünür olur; yapılandırılmamış bir worker run’ının başarıyla tamamlandığı iddia edilmez.

## 4. Trust Command Center’ı başlatın

Aynı terminalde demo DB’sini ve workspace’i server’a verin:

```bash
export HUQAN_API_KEY="ph-local-demo-key"
export HUQAN_MEMORY_PATH="$DEMO_DIR/memory.json"
export HUQAN_DB_PATH="$DEMO_DB"
export HUQAN_AGENT_WORKER_ENABLED=0
export PORT=3000

npm run server
```

Server şu adreste açılır:

```text
http://127.0.0.1:3000
```

Tarayıcıda **Settings** sekmesine gidin ve şu değerleri girin:

| Alan | Değer |
|---|---|
| API Key | `ph-local-demo-key` |
| Workspace | `product-hunt-demo` |

**Kaydet & Bağlan** düğmesine bastıktan sonra **Observability** sekmesine geçin. UI, metrics, runs, queue ve alerts uçlarını authenticated olarak yükler; canlı olaylar için `/api/observability/stream?workspaceId=product-hunt-demo` SSE bağlantısını açar.

## 5. İki dakikalık Product Hunt demo senaryosu

Aşağıdaki akış ekran kaydı veya canlı walkthrough için kullanılabilir. Toplam süre yaklaşık 90–120 saniyedir.

| Süre | Ekran ve hareket | Söylenecek ana mesaj |
|---:|---|---|
| 0–10 sn | HUQAN başlığı ve local terminal | “AI agent’ınızın ne yaptığı, hangi araçları kullandığı ve ne kadar sürdüğü görünür olsun.” |
| 10–25 sn | `node cli.js quickstart` çıktısı | “HUQAN, mutating write’ı review ve operator approval olmadan canonical memory’ye geçirmiyor; sonunda doğrulanabilir Trust Receipt üretiyor.” |
| 25–40 sn | Trust Command Center → Settings → Observability | `product-hunt-demo` workspace’ine bağlanın; dashboard’un authenticated olduğunu gösterin. |
| 40–55 sn | Metrics kartları | Total Runs = 2, Success Rate = 50%, P95 Latency, Tokens, Cost ve Queue Depth değerlerini gösterin. |
| 55–70 sn | Tool Usage Mix ve Run History | Donut grafikte `verify`, `ask`, `compare` dağılımını; run satırlarında tool listesi ve call count değerlerini gösterin. |
| 70–85 sn | Alerts paneli | `p95_latency_ms > 500` alarmının firing durumunu ve threshold/actual value alanlarını gösterin. |
| 85–105 sn | Live Event Stream + Agent Queue | UI formundan kısa bir demo goal gönderin. Worker kapalı olduğu için job queued kalır; `queue_enqueued` olayı canlı stream’de görünür. |
| 105–120 sn | Dashboard genel görünüm ve güvenlik notu | “Read modelleri workspace-scoped’dir; ham goal/prompt/output veya secret gösterilmez.” diyerek kapatın. |

### Demo anlatımının Product Hunt için kısa İngilizce versiyonu

> **HUQAN makes AI-agent behavior observable without turning your data into a cloud dependency.** Start with a real review-gated Trust Receipt, then open the local command center to inspect run history, tool usage, latency, token cost, alerts, live events, and queue state — all scoped to the selected workspace.

> The demo uses isolated local data. It shows the monitoring workflow, not a claim of production scale or hosted SaaS availability.

## 6. API ile hızlı doğrulama

Dashboard yerine terminalden aynı yüzeyleri kontrol etmek için server çalışırken:

```bash
curl -fsS \
  -H "Authorization: Bearer $HUQAN_API_KEY" \
  "http://127.0.0.1:3000/api/observability/metrics?workspaceId=$DEMO_WORKSPACE&windowMs=86400000"
```

Beklenen metriklerde `totalRuns: 2`, `toolCallCount: 4`, `queueDepth: 0`, `tokenKnown: true` ve `costKnown: true` görülür. Run geçmişi:

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

Workspace parametresi observability GET uçlarında zorunludur. API key vermeden yapılan istek `401 Unauthorized` döndürmelidir. Farklı workspace ile yapılan istek, bu demo workspace’inin verisini döndürmemelidir.

## 7. İsteğe bağlı gerçek worker gösterimi

Gerçek AgentV3 queue execution’ı göstermek için server’ı şu değişkenle başlatabilirsiniz:

```bash
export HUQAN_AGENT_WORKER_ENABLED=1
export HUQAN_AGENT_WORKER_INTERVAL_MS=1000
export HUQAN_AGENT_WORKER_LEASE_MS=120000
npm run server
```

Bu bölüm yalnızca AgentV3 runtime’ı ve araç yürütme ortamı yapılandırılmışsa kullanılmalıdır. Worker’ın temel davranışı lease, retry ve terminal failure telemetry’sidir; dış model/araç konfigürasyonu yoksa bir job’ın başarısız olması beklenebilir. Product Hunt videosunda deterministik seed demo ana akışını, gerçek worker bölümünü ise “optional runtime integration” olarak sunun. Başarılı bir worker run’ı için gerekli dış bağımlılıkları bu local quickstart’ın otomatik olarak sağladığını iddia etmeyin.

## 8. Kayıt ve görsel hazırlığı

Ekran kaydı sırasında yalnızca localhost adresi ve demo API key’i kullanın. Terminalde rastgele UUID’leri kısaltabilirsiniz; ancak `review`, `approved`, `verified`, `canonical`, workspace kapsamı, tool count ve alarm threshold değerlerini gizlemeyin. Bunlar ürünün değerini anlatan güvenli ve gerekli sinyallerdir.

Önerilen görsel seti dört kareden oluşur: Trust Receipt quickstart çıktısı, Observability metrics kartları, Tool Usage Mix + Run History ve Live Event Stream + Alert paneli. Dashboard’un boş veya loading durumunu değil, seed edilmiş workspace’teki kararlı sonucu kaydedin.

## 9. Troubleshooting

| Belirti | Çözüm |
|---|---|
| `better-sqlite3` yüklenemiyor | Node.js 22.13+ kullandığınızı ve platform derleme araçlarının kurulu olduğunu kontrol edin; sonra `npm ci` çalıştırın. |
| Dashboard `401 Unauthorized` gösteriyor | Settings’te API key’in server’daki `HUQAN_API_KEY` ile aynı olduğunu kontrol edin. |
| Dashboard boş görünüyor | Workspace’in tam olarak `product-hunt-demo` olduğunu ve server’ın `$DEMO_DB` ile başlatıldığını kontrol edin. |
| `400` ve workspace hatası | Observability GET istekleri tam olarak bir adet boş olmayan `workspaceId` ister. |
| Queue job çalışmıyor | Deterministik demo için worker bilerek `0`’dır; queue görünürlüğü beklenen davranıştır. Gerçek execution için `HUQAN_AGENT_WORKER_ENABLED=1` ve AgentV3 runtime yapılandırması gerekir. |
| Port dolu | `PORT=3001` gibi başka bir port seçin ve dashboard’u yeni porttan açın. |
| Quickstart kendi memory’sini değiştirdi sanılıyor | `quickstart` throwaway store kullanır; çıktıda `your own memory was not touched` satırını kontrol edin. |

## 10. Temizlik

Server terminalinde `Ctrl+C` ile yalnızca bu demo server’ını durdurun. Sonra geçici DB’yi silin:

```bash
rm -f "$DEMO_DIR/memory.db" "$DEMO_DIR/memory.db-wal" "$DEMO_DIR/memory.db-shm" "$DEMO_DIR/memory.json"
rmdir "$DEMO_DIR" 2>/dev/null || true
```

Bu komut yalnızca rehberde oluşturduğunuz geçici demo klasörünü hedeflemelidir. Gerçek HUQAN memory veya başka bir proje DB’si üzerinde çalıştırmayın.

## Gerçeklik sınırı

Bu rehberin kanıtladığı şey, local-first monitoring MVP’sinin kurulabilir demo akışıdır: kalıcı run/event okuma, workspace-scoped metrics, tool usage summary, alert görünümü, queue state ve authenticated SSE bağlantısı. Bu rehber tek başına hosted SaaS deployment’ı, çok kiracılı production işletimi, belirli bir ölçek/SLA veya üçüncü taraf agent framework entegrasyonu kanıtlamaz.

Product Hunt metninde en doğru ifade **local-first agent observability MVP / open-source beta** olacaktır. Hosted auth, RBAC, retention, rate limiting, backup/restore, notification adapter’ları, load/soak kanıtı ve operasyonel SLO’lar sonraki ürünleşme aşamasının konularıdır.
