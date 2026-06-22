# Runtime Truth Gap Re-Audit After PR #122

Tarih: 2026-06-23
Base: `v0.9.1/pr-ab2-tool-call-gate`
HEAD: `5d1bde8dd76f41e5904431e8ba1a867d3c743f1b`

## Hukum

`PARTIAL_TRUST_LAYER_PLUS_MCP_DOGFOOD`

PR #122 sonrasinda MCP dogfood/client boslugu kapanmistir. Gercek bir child-process stdio JSON-RPC istemcisi; izinli, review, dry-run ve block yollarini dogrulamaktadir. Buna ragmen AXIOM/HUQAN bugun tum giris ve mutation yuzeylerinde zorunlu, inline ve tek tip bir trust boundary uygulamamaktadir. Bu nedenle `FULL_INLINE_TRUST_BOUNDARY` veya tum connector verisinin admission gate'ten gectigi iddia edilmemelidir.

## Kanit Ozeti

- MCP direct tool matrisi `mcpServer.js:694-771` icinde execution oncesi uygulanir.
- `axiom.learn` review envelope doner ve MCP yolunda `kernel.learn()` cagirilmaz (`mcpServer.js:701-709`).
- `axiom.agent` `dry_run_only` doner ve MCP yolunda agent loop calistirilmaz (`mcpServer.js:710-718`).
- Bilinmeyen ve gecersiz tool girdileri explicit fail-closed block doner (`mcpServer.js:719-727`, `mcpServer.js:769-771`).
- Gercek MCP dogfood testi `node mcpServer.js` child process'i acar, absolute temp memory/db env yollarini verir ve JSON-RPC `tools/call` kullanir (`test/mcp-dogfood-client.test.js:25-34`, `test/mcp-dogfood-client.test.js:129-193`).
- HTTP `/api/ingest` API key ile korunur (`server.js:921-931`), ancak sonrasinda `handleIngest()` plugin capability'yi dogrudan calistirir.
- `repo-memory` GitHub/Markdown ingest yolu `kernel.graph.addNode/addEdge` ile aktif grafa dogrudan yazar (`plugins/repo-memory.js:36-39`, `plugins/repo-memory.js:56-144`).
- `company-brain` manual/decision ingest yolu da aktif grafa dogrudan yazar (`plugins/company-brain.js:44-47`, `plugins/company-brain.js:169-277`).
- Ayrik `lib/github-connector.js` provenance, candidate claim ve conflict/admission routing saglar (`lib/github-connector.js:167-303`, `lib/github-connector.js:318-388`), fakat aktif `repoMemory` plugin ingest yolu bu connector katmanini kullanmaz.
- Plugin capability calistirma mekanizmasi capability varligini kontrol eder; admission/trust policy zorunlulugu uygulamaz (`plugin.js:230-242`, `kernel.js:212-219`).

## Runtime Yuzey Matrisi

| Yuzey | Giris | Gate / auth | Provenance | Admission | Trust Receipt | Dogfood / test | Siniflandirma |
|---|---|---|---|---|---|---|---|
| MCP ask/verify | `mcpServer.js::callTool` | Allowlist, fail-closed | Verify evidence mevcut | Mutation yok | Verify envelope icinde preview olabilir | Gercek stdio client | Kapali |
| MCP learn | `axiom.learn` | `review` | Islem gerceklesmez | Direct mutation engelli | Gate envelope | Unit + stdio dogfood | Kapali |
| MCP agent | `axiom.agent` | `dry_run_only` | Islem gerceklesmez | Direct loop engelli | Gate envelope | Unit + stdio dogfood | Kapali |
| MCP unknown/invalid | `tools/call` | Explicit `block` | Yok | Islem yok | Block envelope | Unit + stdio dogfood | Kapali |
| HTTP verify | `POST /v2/verify` | Default auth; explicit demo flag | Authenticated full, public sanitized | Read-only | Authenticated full envelope | Contract test | Kapali |
| HTTP ingest | `POST /api/ingest` | API key | Kaynak metadatasi parcali | Plugin'e gore degisiyor | Uniform degil | Server testleri | Kismi |
| CLI teach/load | `cli.js` | Yerel operator | Zorunlu degil | `kernel.learn/learnDocument` direct | Uniform degil | Unit test | Acik yerel yol |
| CLI agent | `cli.js::ajan` | Yerel operator | Tool'a gore | Agent gercek calisir | Uniform degil | Unit test | Acik yerel yol |
| GitHub connector | `lib/github-connector.js` | Cagirani esas alir | Canonical provenance | Candidate/conflict route var | Query helper var | Connector testleri | Kismi, iyi temel |
| Repo GitHub ingest | `plugins/repo-memory.js` | Capability + caller auth | Edge metadata, canonical bundle degil | Direct graph write | Yok | Plugin testleri | Gap |
| Markdown ingest | `plugins/repo-memory.js` | Capability + caller auth | `sourceRef/sourceType` metadata | Direct graph write | Yok | Adapter/plugin testleri | Gap |
| Manual/decision ingest | `plugins/company-brain.js` | Capability + caller auth | Basit source metadata | Direct graph write | Yok | Plugin testleri | Gap |
| Memory API | `lib/memory-store.js` | Caller boundary | Memory provenance uretir | Workspace izolasyonu var | Memory event/query | Core tests | Kismi |
| Plugin capability | `plugin.js::runCapability` | Capability existence | Plugin'e birakilmis | Zorunlu gate yok | Zorunlu degil | Plugin tests | Gap |

## Kapanan Gapler

1. MCP direct learn bypass kapandi: MCP `axiom.learn` canonical memory'yi mutate etmiyor.
2. MCP direct agent bypass kapandi: MCP `axiom.agent` gercek agent loop baslatmiyor.
3. Unknown/null/invalid MCP tool girdileri crash yerine explicit block donuyor.
4. MCP davranisi yalniz unit seviyesinde degil, child-process stdio JSON-RPC istemcisiyle dogrulandi.
5. Dogfood testi temp memory/db yollarini kullanir ve kendi calismasi sonrasinda repo-root artifact sizintisini kontrol eder.
6. HTTP public verify default protected; demo modu sanitized ve workspace probing'e kapali.
7. Persistence path confinement, workspace isolation ve DoS limitleri mevcut testlerle korunuyor.

## Kalan Gapler

### P1 - Connector-to-Graph Admission Birligi

Aktif `repoMemory` ve `companyBrain` plugin yollarinda connector girdisi candidate/admission katmanina zorunlu olarak ugramadan `graph.addNode/addEdge` cagrisina ulasabiliyor. `lib/github-connector.js` dogru provenance/candidate routing temelini sagliyor, fakat bu temel aktif GitHub repo ingest plugin yoluna bagli degil.

Oneri: sonraki dar PR, yalniz connector/plugin ingest mutation'larini ortak provenance + candidate admission kontratina baglamali. Accepted/rejected/pending durumlari aktif graf yazimindan once belirlenmeli.

### P1 - Mandatory Inline Enforcement

MCP siniri guclu; fakat CLI, plugin capability ve bazi yerel runtime yollarinda trust gate zorunlu degil. Yerel operator yetkisi ayri bir policy olabilir, ancak urun iddiasi bu istisnalari acikca tanimlamadan “tum aksiyonlar inline yargilanir” olmamali.

Oneri: yuzey bazli policy matrisi kod kontrati haline getirilmeli. Hangi yerel yollarin trusted-operator bypass oldugu, hangilerinin candidate/review gerektirdigi testle sabitlenmeli.

### P1 - Uniform Trust Receipt

Verify ve provenance query katmaninda Trust Receipt destegi vardir; connector/plugin mutation sonuclarinda uniform receipt zorunlulugu yoktur. Bir kaydin neden accepted, pending veya rejected oldugu her ingest sonucunda ayni envelope ile donmuyor.

Oneri: admission sonucu icin minimal, workspace-scoped receipt kontrati tanimlanmali; private provenance HTTP public response'a sizdirilmamali.

### P2 - Test Artifact Hygiene

`npm test` sifir failure ile tamamlanmasina ragmen ignored repo-root `memory.db` olusturur. Statik cagri zinciri teyitlidir:

`agentRuntime.test.js:43` -> `createAgent({ kernel })` -> `agentRuntime.js:37` -> `new AxiomStorage(storageOpts)` -> `storage.js:41` -> `process.cwd()/memory.db`.

Bu artifact staged/committed degildir ve audit sirasinda exact-path cleanup ile kaldirilmistir. PR #122 dogfood testi kendi MCP calismasi icin artifact sizintisi yapmamaktadir; sorun full-suite icindeki default storage test wiring'indedir.

Oneri: ayri bir test-hygiene PR'inda `agentRuntime.test.js` ve benzer default-storage testleri isolated temp `dbPath` kullanmali ve cleanup yapmalidir. Runtime default davranisi bu docs PR'inda degistirilmemelidir.

## Test Kaniti

Temiz worktree ve exact merged HEAD uzerinde:

- `npm ci` -> PASS, 0 vulnerability
- `npm test` -> PASS, 840 total / 824 pass / 0 fail / 16 skipped
- `node --test test/mcp-dogfood-client.test.js` -> PASS, 1/1
- `node --test mcpServer.test.js` -> PASS, 6/6
- `node --test test/mcp-server-gate-enforcement.test.js` -> PASS, 6/6
- `node --test test/tool-call-bypass-regression.test.js` -> PASS, 42/42
- `node --test test/v2-verify-public-contract.test.js` -> PASS, 8/8

## Sonuc ve Sonraki Dar PR

MCP dogfood/client gap kapandi. AXIOM/HUQAN'in MCP yuzeyi icin fail-closed trust enforcement iddiasi kanitlidir. Tum urun icin mandatory inline trust boundary iddiasi ise connector/plugin/CLI istisnalari nedeniyle erken olur.

Onerilen sonraki paket:

`TRUTH-4B — Connector-to-Graph Mandatory Admission`

Dar hedef:

1. GitHub ve Markdown plugin ingest yollarini canonical provenance/candidate routing'e baglamak.
2. Pending/rejected girdinin aktif grafa yazilmadigini test etmek.
3. Accepted girdinin workspace-scoped provenance ve audit kaydi ile yazildigini test etmek.
4. Manual/decision ingest'i ayni PR'a ancak ayni ortak helper ile dar kalabiliyorsa almak; aksi halde ayri PR yapmak.

Bu audit runtime kodu, test kodu, UI, package veya dirty root degistirmemistir.
