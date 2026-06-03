# â—‡ AXIOM

**LLM'ler iÃ§in deterministik doÄŸrulama motoru.**

LLM Ã§Ä±ktÄ±larÄ±nÄ± doÄŸrular, Ã§eliÅŸkileri tespit eder, nedensellik zinciri kurar. GPU yok, bulut API yok, sÄ±fÄ±r dÄ±ÅŸ baÄŸÄ±mlÄ±lÄ±k.

> *"LLM'ler kumdan kale. AXIOM granit."*

---

## HÄ±zlÄ± BaÅŸlangÄ±Ã§

```bash
npm install
node egitim.js   # BaÅŸlangÄ±Ã§ bilgi tabanÄ±nÄ± yÃ¼kle
node cli.js      # CLI
node server.js   # Web arayÃ¼zÃ¼ â†’ http://localhost:3000
node mcpServer.js  # Claude Desktop / Cursor iÃ§in MCP sunucu
```

Node.js >= 18 gereklidir. Dış bağımlılık yoktur.

AXIOM v0.8 introduces the Trust Kernel and AXIOM Trust Protocol v0.1: provenance, trust policy, append-only audit, workspace scoping, conflict quarantine, Trust Receipts, ATP/AVP conformance, `.axiom` package format draft, and the minimal `axiom-verify` package skeleton.

---

## Ne Yapar?

```
LLM (Ollama/OpenAI)     KullanÄ±cÄ± (CLI/REST/MCP)
       |                         |
       v                         v
   llmAdapter               kernel.v2
       |                         |
       +-----â†’ verify() â†--------+
                    |
             [Ã‡eliÅŸki var?]
              /           \
            Evet          HayÄ±r
             |              |
        UyarÄ± + reddet   Ã–ÄŸren + kaydet
```

| Ã–zellik | AXIOM | LLM-only |
|---|---|---|
| DoÄŸrulama | Deterministik, sembolik | OlasÄ±lÄ±ksal |
| Ã‡eliÅŸki tespiti | Evet (olumsuzlama, zÄ±t, Ã§ok adÄ±mlÄ±) | HayÄ±r |
| HafÄ±za | KalÄ±cÄ± SQLite + JSON | BaÄŸlam penceresi |
| GPU/Bulut | Gerekmez | Gerekir |
| Maliyet | $0 | $/sorgu |
| F1 (doÄŸrulama) | 0.88â€“0.91 | 0.82â€“0.86 |
| Dil | TÃ¼rkÃ§e + Ä°ngilizce | Ä°ngilizce aÄŸÄ±rlÄ±klÄ± |

---

## CLI KomutlarÄ±

### Temel Ã–ÄŸrenme ve Sorgulama

| Komut | AÃ§Ä±klama |
|---|---|
| `kedi hayvandÄ±r` | Bilgi Ã¶ÄŸret |
| `kedi nedir` | Soru sor |
| `sor: kedi nedir` | AÃ§Ä±k soru |
| `Ã¶ÄŸret: kedi balÄ±k yer` | AÃ§Ä±k Ã¶ÄŸret |
| `neden tavuk` | Nedensellik zinciri |
| `tavuk mu yumurta mÄ±` | KarÅŸÄ±laÅŸtÄ±r |

### Sistem

| Komut | AÃ§Ä±klama |
|---|---|
| `durum` / `nasÄ±lsÄ±n` | DÃ¼ÄŸÃ¼m/kenar/entropi/Ã§eliÅŸki Ã¶zeti |
| `rÃ¼ya` | Hipotez Ã¼ret |
| `aÃ§Ä±k dÃ¼ÅŸÃ¼n` | Arka planda otomatik hipotez |
| `dur dÃ¼ÅŸÃ¼nme` | Otomatik dÃ¼ÅŸÃ¼nmeyi durdur |
| `optimize` | ZayÄ±f kenarlarÄ± buda |
| `kaydet` | HafÄ±zayÄ± diske yaz |
| `Ã§Ä±kÄ±ÅŸ` / `bb` | Ã‡Ä±kÄ±ÅŸ (otomatik kaydeder) |

### LLM ve Belge

| Komut | AÃ§Ä±klama |
|---|---|
| `llm-sor: soru` | LLM'ye sor â†’ doÄŸrula â†’ otomatik Ã¶ÄŸren |
| `yÃ¼kle: dosya.txt` | `.txt` / `.md` dosyasÄ±ndan Ã¶ÄŸren |

---

## REST API

```bash
node server.js   # http://localhost:3000
```

### Endpoints

```
GET  /api?q=kedi+nedir
GET  /dogrula?statement=kedi+hayvandir
POST /dogrula    { "statement": "kedi hayvandÄ±r" }
POST /yukle      { "text": "kedi hayvandÄ±r\nkÃ¶pek memelidir" }
POST /llm-sor    { "question": "kedi nedir?", "autoLearn": true }
GET  /graph-data
```

`/dogrula` cevabÄ±: `{ "status": "dogrulandi" | "celiski" | "bilinmiyor", "confidence": 0.9, "evidence": [...] }`

---

## MCP Sunucu

Claude Desktop, Cursor ve diÄŸer MCP destekli araÃ§lar iÃ§in:

```bash
node mcpServer.js
```

AraÃ§lar: `axiom.learn` Â· `axiom.ask` Â· `axiom.verify` Â· `axiom.reason` Â· `axiom.compare` Â· `axiom.dream` Â· `axiom.plan` Â· `axiom.agent` Â· `axiom.policy` Â· `axiom.approvals`

```json
{
  "mcpServers": {
    "axiom": {
      "command": "node",
      "args": ["/path/to/axiom/mcpServer.js"]
    }
  }
}
```

---

## LLM Entegrasyonu

### Ollama (Ã¶nerilen, Ã¼cretsiz)

```bash
ollama serve
ollama pull llama3.2:3b
node cli.js
axiom> llm-sor: kedi memeli midir?
```

### OpenAI

```bash
OPENAI_API_KEY=sk-... node cli.js
```

### Paranoid Mod (LLM Ã¶ÄŸrenmeyi engelle)

```bash
AXIOM_PARANOID=1 node cli.js
```

---

## Mimari

```
kernel.js         â€” Ã–ÄŸrenme, sorgulama, verify(), learnFromLLM(), nedensellik
kernel.v2.js      â€” YapÄ±landÄ±rÄ±lmÄ±ÅŸ envelope API, manipÃ¼lasyon tespiti, enhanced verify
graph.js          â€” Graf motoru + SQLite/JSON Ã§ift kalÄ±cÄ±lÄ±k katmanÄ±
dream.js          â€” Hipotez motoru (Node2Vec embedding, benzerlik keÅŸfi)
llmAdapter.js     â€” Ollama + OpenAI wrapper, hata sarmalama
causalSimulator.js â€” What-if nedensel simÃ¼lasyon (v0.7)
evidence-ranker.js â€” KanÄ±t kalitesi sÄ±ralama (user_opinionâ†’replicated)
finalizer.js      â€” Deterministik Ã¶zet ve Ã¶neri Ã¼retimi
agent.js          â€” Hafif Ã§ok adÄ±mlÄ± agent runtime
agent.v3.js       â€” Checkpoint/resume destekli agent
agentRuntime.js   â€” Agent versiyonu ve runtime seÃ§ici
storage.js        â€” SQLite: checkpoint, hedef hafÄ±zasÄ±, tool approval
toolPolicy.js     â€” AraÃ§ gÃ¼venlik politikasÄ±
requestGuards.js  â€” Girdi doÄŸrulama ve sanitizasyon
plugin.js         â€” Event-driven plugin sistemi
cli.js            â€” TÃ¼rkÃ§e doÄŸal dil parser + async LLM desteÄŸi
server.js         â€” REST API + D3.js interaktif graf arayÃ¼zÃ¼
mcpServer.js      â€” MCP stdio sunucu (10 araÃ§)
```

---

## Testler

```bash
npm test              # TÃ¼m testler (468 test)
npm run test:graph
npm run test:kernel
npm run test:cli
npm run test:dream
npm run test:plugin
npm run test:server
npm run test:backup
```

---

## Benchmark

```bash
npm run bench           # TÃ¼m benchmark
npm run bench:verify    # DoÄŸrulama benchmark
```

| Graf boyutu | learn | ask | verify | reason | compare | dream |
|---|---|---|---|---|---|---|
| small | ~50ms | ~0.4ms | ~0.25ms | ~0.4ms | ~0.45ms | ~1.8ms |
| medium | ~44ms | ~0.09ms | ~0.06ms | ~0.26ms | ~0.09ms | ~1.7ms |
| large | ~43ms | ~0.07ms | ~0.03ms | ~0.10ms | ~0.07ms | ~5.6ms |

---

## HafÄ±za

| Dosya | Ä°Ã§erik |
|---|---|
| `memory.db` | SQLite â€” graf, checkpoint, agent hafÄ±zasÄ±, araÃ§ onaylarÄ± (WAL) |
| `memory.json` | JSON yedek â€” Rust katmanÄ± ve fallback |
| `memory.embeddings.json` | Node2Vec vektÃ¶rleri (ayrÄ±, ÅŸiÅŸmeyi Ã¶nler) |

SQLite varsayÄ±lan. Devre dÄ±ÅŸÄ±: `AXIOM_USE_SQLITE=false`

---

## Plugin Sistemi

`plugins/` klasÃ¶rÃ¼ne `.js` dosyasÄ± bÄ±rak, otomatik yÃ¼klenir.

```js
module.exports = {
  name: 'my-plugin',
  init(kernel) {},
  beforeLearn(kernel, data) { /* data.text deÄŸiÅŸtirilebilir */ },
  afterLearn(kernel, data) {},
  beforeAsk(kernel, data) { /* data.question deÄŸiÅŸtirilebilir */ },
  afterAsk(kernel, data) {},
  beforeDream(kernel, data) {},
  afterDream(kernel, data) { /* data.hypotheses */ },
  beforeEmbedding(kernel, opts) {},
  afterEmbedding(kernel, result) {},
};
```

---

## Docker

```bash
docker-compose up
```

---

## Ortam DeÄŸiÅŸkenleri

| DeÄŸiÅŸken | AÃ§Ä±klama | VarsayÄ±lan |
|---|---|---|
| `AXIOM_PARANOID` | `1` â†’ LLM Ã¶ÄŸrenmeyi engelle | - |
| `AXIOM_AGENT_VERSION` | `v2` veya `v3` | `v2` |
| `AXIOM_AGENT_RUNTIME` | `classic` veya `workflow` | `classic` |
| `AXIOM_KERNEL_VERSION` | `v2` â†’ KernelV2 kullan | - |
| `AXIOM_MEMORY_PATH` | Graf JSON dosyasÄ± | `memory.json` |
| `AXIOM_DB_PATH` | SQLite dosyasÄ± | `memory.db` |
| `AXIOM_USE_SQLITE` | `false` â†’ JSON'a dÃ¼ÅŸ | `true` |
| `OPENAI_API_KEY` | OpenAI API anahtarÄ± | - |

---

## Versiyon

**v0.9.0** — Trust Kernel & AXIOM Trust Protocol, 592 test

[CHANGELOG](./CHANGELOG.md) Â· [ROADMAP](./ROADMAP.md) Â· [MIT Lisans](./LICENSE)



