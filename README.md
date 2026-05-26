# â—‡ AXIOM

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/Tests-207%2F207-green)]()
[![Dependencies](https://img.shields.io/badge/Dependencies-0-blue)]()
[![Platform](https://img.shields.io/badge/Platform-Windows%20|%20macOS%20|%20Linux-lightgrey)]()

> **English:** A symbolic AI reasoning engine that works without
> LLMs, GPUs, or cloud. Learns from natural language,
> verifies LLM outputs, detects contradictions, and generates
> hypotheses autonomously. Zero external dependencies.

TÃ¼rkÃ§e doÄŸal dil ile Ã§alÄ±ÅŸan, kendi kendine Ã¶ÄŸrenen bilgi grafiÄŸi motoru.

LLM yanÄ±tlarÄ±nÄ± doÄŸrular, Ã§eliÅŸkileri tespit eder ve kiÅŸisel hafÄ±za katmanÄ± olarak Ã§alÄ±ÅŸÄ±r. Ollama veya OpenAI ile entegre olur, Ã¶ÄŸrenilen bilgileri SQLite'ta kalÄ±cÄ± olarak saklar.

---

## HÄ±zlÄ± BaÅŸlangÄ±Ã§

```bash
# 1. BaÄŸÄ±mlÄ±lÄ±klarÄ± kur
npm install

# 2. BaÅŸlangÄ±Ã§ bilgi tabanÄ±nÄ± yÃ¼kle
node egitim.js

# 3. CLI ile konuÅŸ
node cli.js

# 4. Web arayÃ¼zÃ¼ (http://localhost:3000)
node server.js
```

Node.js >= 18 gereklidir.

---

## Komutlar

### Temel

| Komut | AÃ§Ä±klama |
|---|---|
| `kedi hayvandÄ±r` | Bilgi Ã¶ÄŸret |
| `kedi nedir` | Soru sor |
| `sor: kedi nedir` | AÃ§Ä±k soru komutu |
| `Ã¶ÄŸret: kedi balÄ±k yer` | AÃ§Ä±k Ã¶ÄŸret komutu |
| `neden tavuk` | Sebep-sonuÃ§ analizi |
| `tavuk mu yumurta mÄ±` | Ä°ki kavramÄ± karÅŸÄ±laÅŸtÄ±r |

### Sistem

| Komut | AÃ§Ä±klama |
|---|---|
| `durum` / `nasÄ±lsÄ±n` | DÃ¼ÄŸÃ¼m/kenar sayÄ±sÄ±, entropi, Ã§eliÅŸkiler |
| `rÃ¼ya` | Hipotez Ã¼ret (benzerlik, zincir, simetri) |
| `aÃ§Ä±k dÃ¼ÅŸÃ¼n` | Arka planda otomatik hipotez Ã¼retimi baÅŸlat |
| `dur dÃ¼ÅŸÃ¼nme` | Otomatik dÃ¼ÅŸÃ¼nmeyi durdur |
| `optimize` | ZayÄ±f kenarlarÄ± buda, eski dÃ¼ÄŸÃ¼mleri temizle |
| `kaydet` | HafÄ±zayÄ± diske yaz |
| `Ã§Ä±kÄ±ÅŸ` / `bb` | Ã‡Ä±kÄ±ÅŸ (otomatik kaydeder) |

### LLM & Belge

| Komut | AÃ§Ä±klama |
|---|---|
| `llm-sor: soru` | LLM'ye sor â†’ AXIOM doÄŸrula â†’ otomatik Ã¶ÄŸren |
| `yÃ¼kle: dosya.txt` | `.txt` veya `.md` dosyasÄ±ndan Ã¶ÄŸren |

---

## LLM Entegrasyonu

AXIOM, Ollama (local, Ã¼cretsiz) ve OpenAI ile Ã§alÄ±ÅŸÄ±r.

### Ollama (Ã¶nerilen)

```bash
# Ollama kur: https://ollama.com
ollama serve
ollama pull llama3.2:3b

node cli.js
axiom> llm-sor: kedi memeliler sÄ±nÄ±fÄ±na girer mi?
```

`llm-sor:` komutu ÅŸu adÄ±mlarÄ± otomatik yapar:
1. AXIOM'un mevcut bilgisiyle Ã¶n doÄŸrulama
2. LLM'ye soru gÃ¶nder
3. LLM yanÄ±tÄ±nÄ± AXIOM ile Ã§apraz doÄŸrula
4. Ã‡eliÅŸki yoksa yanÄ±tÄ± otomatik hafÄ±zaya ekle

### OpenAI

```bash
OPENAI_API_KEY=sk-... node cli.js
```

---

## REST API

Sunucu `node server.js` ile baÅŸlatÄ±lÄ±r.

### Sohbet

```
GET /api?q=kedi+nedir
â†’ { "result": "ğŸ’¬ kedi hayvan" }
```

### DoÄŸrulama

```
GET  /dogrula?statement=kedi+hayvandÄ±r
POST /dogrula  { "statement": "kedi hayvandÄ±r" }
â†’ { "status": "dogrulandi", "confidence": 0.9, "evidence": [...] }
```

OlasÄ± `status` deÄŸerleri: `dogrulandi` Â· `celiski` Â· `bilinmiyor`

### Structured v2 Verify

`/v2/verify` returns the full Core API envelope for integrations, dashboards, and MCP-like clients. Legacy `/dogrula` and `/verify` still keep the old JSON shape.

```http
GET  /v2/verify?statement=kedi+hayvandir
POST /v2/verify  { "statement": "kedi hayvandir" }
```

```js
{
  ok: true,
  type: "verify",
  data: { status: "dogrulandi", confidence: 0.9 },
  evidence: [/* Evidence[] */],
  error: null,
  meta: { contractVersion: "1.0.0", backend: "sqlite" }
}
```

---

## Core API Contract

AXIOM v2 core methods (`learn`, `ask`, `verify`, `reason`, `compare`, `dream`) return the same structured envelope. The current contract version is `1.0.0`:

```js
{
  ok: true,
  type: "verify",
  data: { status: "dogrulandi", confidence: 0.9 },
  evidence: [
    {
      kind: "direct_edge",
      text: "kedi --[t\u00fcr]--> hayvan",
      confidence: 0.9,
      nodes: ["kedi", "hayvan"],
      edges: [{ from: "kedi", to: "hayvan", relation: "t\u00fcr" }]
    }
  ],
  error: null,
  meta: {}
}
```

CLI and legacy REST endpoints keep their user-facing output stable. Code that imports `Kernel` directly, MCP clients, and the `/v2/verify` endpoint can consume the structured contract.

### Paranoid Mode

`paranoidMode` disables `learnFromLLM` and any external LLM-backed learning path while keeping local symbolic reasoning active.

## Language Strategy

AXIOM is currently Turkish-first and rule-based.
`lang: auto` mode can detect the pack from the input text for `extractFacts()`.

| Pack | Status | Purpose |
|---|---|---|
| Turkish | Mature | Core parsing, normalization, and contradiction detection |
| English | Available | Proof that the language-pack interface works |
| German | Available | Copula-based parser example with umlaut-safe normalization |
| Arabic | Available | Right-to-left pack example with prefix stripping |

- The core engine stays language-agnostic.
- New languages should be added as lightweight parsing / normalization packs, not by retraining the symbolic core.
- Full multilingual training is not required for the core engine, but it can be layered later if we want deeper natural-language coverage.
- Best next step: keep the symbolic core stable, then add small language modules where they create real user value.

## Agent Status

AXIOM has a lightweight agent layer, persistent goal memory, a retry-aware LLM adapter, and a basic multi-step planner, but it is not yet a full autonomous planner.

- `dream` generates hypotheses and speculative links.
- `plugin.js` provides hooks for extending behavior.
- `llm-sor` can verify, cross-check, and optionally learn from LLM output.
- `plan: hedef` generates a lightweight execution plan.
- `ajan: hedef` runs the multi-step agent loop and returns a report.
- The planner now keeps a small local memory file, remembers previous goals, avoids repeating recent failures, and biases tool selection with a simple policy layer.
- It also detects stalled progress and can switch to hypothesis mode when repeated steps stop producing new signal.
- What is still missing for a stronger agent story: richer autonomous loops and a longer-running workflow layer.

## MCP Adapter

AXIOM also exposes a minimal stdio-based MCP server for tool-driven clients:

```bash
npm run mcp
```

Available tools:
- `axiom.learn`
- `axiom.ask`
- `axiom.verify`
- `axiom.reason`
- `axiom.compare`
- `axiom.dream`

The adapter returns both human-readable `content` and structured MCP `structuredContent` so clients can choose the format they prefer.

Set `AXIOM_KERNEL_VERSION=v2` to expose the newer `KernelV2.verify` behavior through MCP. The `axiom.verify` output schema includes v2.1 fields such as `inferred`, `reasoningPath`, `pathLength`, `confidenceSource`, and `contradictionReason`.

The MCP tool catalog is now described with concrete payload shapes for `learn`, `ask`, `reason`, `compare`, `dream`, `verify`, `plan`, `agent`, and `policy`, so external clients can wire against the schema instead of guessing the response shape.

The same flag also enables `KernelV2` for CLI and REST flows:

```bash
AXIOM_KERNEL_VERSION=v2 node cli.js
AXIOM_KERNEL_VERSION=v2 node server.js
```

## Benchmarks

Run deterministic local performance checks with:

```bash
npm run bench
npm run bench:verify
```

Fixture sizes live under `benchmarks/fixtures/` and are intentionally stable so results can be compared across commits.

## Release Notes

For the current v2 shipping status and next-phase priorities, see [RELEASE_V2.md](./RELEASE_V2.md), [ROADMAP_V2.md](./ROADMAP_V2.md), [RELEASE_NOTES_v2.0.0.md](./RELEASE_NOTES_v2.0.0.md), and [PUBLIC_RELEASE_POST.md](./PUBLIC_RELEASE_POST.md).

## V2 Status (Single View)

- Phase 1 Core Contract: done
- Phase 2 MCP Polish: done
- Phase 3 Benchmark Regression: done
- Phase 4 Packaging/Docs: done
- v2.1 Verify Reasoning: done
- v2.2 MCP Schema Reflection: done
- v2.3 CLI/REST Runtime: done
- v2.4 Status Dashboard: done
- v2.5 REST Structured Verify: done
- v2.6 MCP Schema Polish: done
- v2.7 Manipulation Guard: done
- v2.8 Status Dashboard Polish: done
- v2.9 Evidence Polish: done
- v3.0 Agent Workflow: in progress, with opt-in checkpointed runtime via `AXIOM_AGENT_VERSION=v3`
- Test status: `209/209`

## Current Remaining Work

The next practical work is captured in [NEXT_STEPS.md](./NEXT_STEPS.md). In short:

- finish the stronger v3 agent loop with checkpoint/resume
- opt into `AXIOM_AGENT_VERSION=v3` when you want the checkpointed runtime
- harden security and request handling
- add basic operational packaging such as Docker and CI
- keep language packs lightweight and only expand where they create clear user value

Security note: write-heavy HTTP endpoints can be protected with `AXIOM_API_KEY`. If set, the server accepts `Authorization: Bearer ...` or `X-API-Key: ...` and applies input length, JSON body, and rate-limit guards before mutating memory.

## Benchmark Baseline

Committed benchmark summaries live in [benchmarks/results.json](./benchmarks/results.json). The regression workflow compares fresh runs against that baseline on every push to `main`.

### Belge YÃ¼kleme

```
POST /yukle  { "text": "kedi hayvandÄ±r\nkÃ¶pek memelidir" }
â†’ { "ok": true, "learned": 2 }
```

Maksimum 1 MB. YÃ¼kleme sonrasÄ± otomatik kaydedilir.

### LLM Soru

```
POST /llm-sor  { "question": "kedi nedir?", "autoLearn": true }
â†’ {
    "ok": true,
    "llmAnswer": "...",
    "axiomCheck": { "status": "dogrulandi", ... },
    "llmCheck":   { "status": "bilinmiyor", ... },
    "learnResult": { "learned": 3, "skipped": 1, "conflicts": [] }
  }
```

### Graf Verisi

```
GET /graph-data
â†’ { "nodes": [...], "links": [...] }
```

Web arayÃ¼zÃ¼ndeki Graf sekmesi bu endpoint'i kullanÄ±r.

---

## Web ArayÃ¼zÃ¼

`http://localhost:3000` adresinde iki sekme bulunur:

**Sohbet** â€” TÃ¼m CLI komutlarÄ±nÄ± web Ã¼zerinden kullan.

**Graf** â€” D3.js force-directed interaktif gÃ¶rselleÅŸtirme.
- DÃ¼ÄŸÃ¼m bÃ¼yÃ¼klÃ¼ÄŸÃ¼ kenar sayÄ±sÄ±na gÃ¶re Ã¶lÃ§eklenir
- Renk kodlamasÄ±: `tÃ¼r` mor Â· `yapabilir` cyan Â· `benzer` yeÅŸil Â· `Ã¶zellik` turuncu Â· `hipotez` kÄ±rmÄ±zÄ± kesikli
- DÃ¼ÄŸÃ¼me tÄ±kla â†’ kenar listesi paneli aÃ§Ä±lÄ±r
- SÃ¼rÃ¼kle, zoom, etiket toggle

---

## Testler

```bash
# TÃ¼m testler (167 test)
npm test

# ModÃ¼l bazlÄ±
npm run test:graph
npm run test:kernel
npm run test:cli
npm run test:dream
npm run test:plugin
node --test llmAdapter.test.js
```

---

## Mimari

```
kernel.js        â€” Ã–ÄŸrenme, sorgulama, Ã§Ä±karÄ±m, verify(), learnFromLLM()
graph.js         â€” Graf veri yapÄ±sÄ± + SQLite/JSON Ã§ift katman
dream.js         â€” Hipotez motoru (node2vec embedding, benzerlik keÅŸfi)
llmAdapter.js    â€” Ollama + OpenAI wrapper ({ ok, data, error })
plugin.js        â€” Event-driven plugin sistemi
agent.js         â€” Goal planning + multi-step agent execution
cli.js           â€” DoÄŸal dil parser + async LLM desteÄŸi
server.js        â€” HTTP API + D3.js graf arayÃ¼zÃ¼ + rate limiting
rustGraph.js     â€” Rust binary kÃ¶prÃ¼sÃ¼ (opsiyonel hÄ±zlandÄ±rÄ±cÄ±)
egitim.js        â€” BaÅŸlangÄ±Ã§ eÄŸitim verisi (mantÄ±k, felsefe, bilim)
```

---

## HafÄ±za

| Dosya | Ä°Ã§erik |
|---|---|
| `memory.db` | SQLite â€” dÃ¼ÄŸÃ¼mler + kenarlar (WAL modu, crash-safe) |
| `memory.json` | JSON yedek â€” Rust katmanÄ± ve fallback iÃ§in |
| `memory.embeddings.json` | Node2Vec vektÃ¶rleri (ayrÄ± tutulur, ÅŸiÅŸmeyi Ã¶nler) |

SQLite varsayÄ±lan olarak aktif. Devre dÄ±ÅŸÄ± bÄ±rakmak iÃ§in:

```js
const g = new Graph({ useSQLite: false });
```

---

## Plugin Sistemi

`plugins/` klasÃ¶rÃ¼ne `.js` dosyasÄ± bÄ±rak, otomatik yÃ¼klenir.

```js
// plugins/my-plugin.js
module.exports = {
  name: 'my-plugin',
  init(kernel) { /* baÅŸlangÄ±Ã§ */ },
  beforeLearn(kernel, data) { /* data.text deÄŸiÅŸtirilebilir */ },
  afterLearn(kernel, data) { /* Ã¶ÄŸrenme sonrasÄ± */ },
  beforeAsk(kernel, data) { /* data.question deÄŸiÅŸtirilebilir */ },
  afterAsk(kernel, data) { /* data.answer okunabilir */ },
  beforeDream(kernel, data) { },
  afterDream(kernel, data) { /* data.hypotheses */ },
  beforeEmbedding(kernel, opts) { /* opts.dimensions deÄŸiÅŸtirilebilir */ },
  afterEmbedding(kernel, result) { },
};
```

---

## Rust HÄ±zlandÄ±rÄ±cÄ± (Opsiyonel)

`axiom-core/` dizininde Rust ile yazÄ±lmÄ±ÅŸ bir graf motoru bulunur. Rust binary varsa otomatik kullanÄ±lÄ±r, yoksa JS katmanÄ±na dÃ¼ÅŸer.

```bash
# Windows cross-compile
cd axiom-core
cargo build --release --target x86_64-pc-windows-gnu
```

---

## Gereksinimler

- Node.js >= 18
- `better-sqlite3` (npm ile otomatik kurulur)
- Ollama (opsiyonel, local LLM iÃ§in)
- Rust toolchain (opsiyonel, hÄ±zlandÄ±rÄ±cÄ± iÃ§in)

