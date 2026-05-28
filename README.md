?# �-? AXIOM

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/Tests-207%2F207-green)]()
[![Dependencies](https://img.shields.io/badge/Dependencies-0-blue)]()
[![Platform](https://img.shields.io/badge/Platform-Windows%20|%20macOS%20|%20Linux-lightgrey)]()

> **English:** A symbolic AI reasoning engine that works without
> LLMs, GPUs, or cloud. Learns from natural language,
> verifies LLM outputs, detects contradictions, and generates
> hypotheses autonomously. Zero external dependencies.

Türkçe do�Yal dil ile çalı�Yan, kendi kendine ö�Yrenen bilgi grafi�Yi motoru.

LLM yanıtlarını do�Yrular, çeli�Ykileri tespit eder ve ki�Yisel hafıza katmanı olarak çalı�Yır. Ollama veya OpenAI ile entegre olur, ö�Yrenilen bilgileri SQLite'ta kalıcı olarak saklar.

---

## Hızlı Ba�Ylangıç

```bash
# 1. Ba�Yımlılıkları kur
npm install

# 2. Ba�Ylangıç bilgi tabanını yükle
node egitim.js

# 3. CLI ile konu�Y
node cli.js

# 4. Web arayüzü (http://localhost:3000)
node server.js
```

Node.js >= 18 gereklidir.

---

## Komutlar

### Temel

| Komut | Açıklama |
|---|---|
| `kedi hayvandır` | Bilgi ö�Yret |
| `kedi nedir` | Soru sor |
| `sor: kedi nedir` | Açık soru komutu |
| `ö�Yret: kedi balık yer` | Açık ö�Yret komutu |
| `neden tavuk` | Sebep-sonuç analizi |
| `tavuk mu yumurta mı` | İki kavramı kar�Yıla�Ytır |

### Sistem

| Komut | Açıklama |
|---|---|
| `durum` / `nasılsın` | Dü�Yüm/kenar sayısı, entropi, çeli�Ykiler |
| `rüya` | Hipotez üret (benzerlik, zincir, simetri) |
| `açık dü�Yün` | Arka planda otomatik hipotez üretimi ba�Ylat |
| `dur dü�Yünme` | Otomatik dü�Yünmeyi durdur |
| `optimize` | Zayıf kenarları buda, eski dü�Yümleri temizle |
| `kaydet` | Hafızayı diske yaz |
| `çıkı�Y` / `bb` | �?ıkı�Y (otomatik kaydeder) |

### LLM & Belge

| Komut | Açıklama |
|---|---|
| `llm-sor: soru` | LLM'ye sor �?' AXIOM do�Yrula �?' otomatik ö�Yren |
| `yükle: dosya.txt` | `.txt` veya `.md` dosyasından ö�Yren |

---

## LLM Entegrasyonu

AXIOM, Ollama (local, ücretsiz) ve OpenAI ile çalı�Yır.

### Ollama (önerilen)

```bash
# Ollama kur: https://ollama.com
ollama serve
ollama pull llama3.2:3b

node cli.js
axiom> llm-sor: kedi memeliler sınıfına girer mi?
```

`llm-sor:` komutu �Yu adımları otomatik yapar:
1. AXIOM'un mevcut bilgisiyle ön do�Yrulama
2. LLM'ye soru gönder
3. LLM yanıtını AXIOM ile çapraz do�Yrula
4. �?eli�Yki yoksa yanıtı otomatik hafızaya ekle

### OpenAI

```bash
OPENAI_API_KEY=sk-... node cli.js
```

---

## REST API

Sunucu `node server.js` ile ba�Ylatılır.

### Sohbet

```
GET /api?q=kedi+nedir
�?' { "result": "gY'� kedi hayvan" }
```

### Do�Yrulama

```
GET  /dogrula?statement=kedi+hayvandır
POST /dogrula  { "statement": "kedi hayvandır" }
�?' { "status": "dogrulandi", "confidence": 0.9, "evidence": [...] }
```

Olası `status` de�Yerleri: `dogrulandi` · `celiski` · `bilinmiyor`

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

For the current shipped status and release context, see [RELEASE_V2.md](./RELEASE_V2.md), [RELEASE_NOTES_v2.0.0.md](./RELEASE_NOTES_v2.0.0.md), and [PUBLIC_RELEASE_POST.md](./PUBLIC_RELEASE_POST.md).

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
- Test status: `215/215`

## Current Remaining Work

Current remaining work is tracked in the active implementation backlog and, in short, focuses on:

- finish the stronger v3 agent loop with checkpoint/resume
- opt into `AXIOM_AGENT_VERSION=v3` when you want the checkpointed runtime
- harden security and request handling
- add basic operational packaging such as Docker and CI
- keep language packs lightweight and only expand where they create clear user value

## Docker

Build and run with persistent memory and backups:

```bash
docker compose up --build
```

The container stores `memory.json`, `memory.db`, and `backups/` under `/app/data`, exposed through the named volume `axiom-data`.

Health is available at `/health`, and the container healthcheck uses the same endpoint.

Security note: write-heavy HTTP endpoints can be protected with `AXIOM_API_KEY`. If set, the server accepts `Authorization: Bearer ...` or `X-API-Key: ...` and applies input length, JSON body, and rate-limit guards before mutating memory.

## Benchmark Baseline

Committed benchmark summaries live in [benchmarks/results.json](./benchmarks/results.json). The regression workflow compares fresh runs against that baseline on every push to `main`.

### Belge Yükleme

```
POST /yukle  { "text": "kedi hayvandır\nköpek memelidir" }
�?' { "ok": true, "learned": 2 }
```

Maksimum 1 MB. Yükleme sonrası otomatik kaydedilir.

### LLM Soru

```
POST /llm-sor  { "question": "kedi nedir?", "autoLearn": true }
�?' {
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
�?' { "nodes": [...], "links": [...] }
```

Web arayüzündeki Graf sekmesi bu endpoint'i kullanır.

---

## Web Arayüzü

`http://localhost:3000` adresinde iki sekme bulunur:

**Sohbet** �?" Tüm CLI komutlarını web üzerinden kullan.

**Graf** �?" D3.js force-directed interaktif görselle�Ytirme.
- Dü�Yüm büyüklü�Yü kenar sayısına göre ölçeklenir
- Renk kodlaması: `tür` mor · `yapabilir` cyan · `benzer` ye�Yil · `özellik` turuncu · `hipotez` kırmızı kesikli
- Dü�Yüme tıkla �?' kenar listesi paneli açılır
- Sürükle, zoom, etiket toggle

---

## Testler

```bash
# Tüm testler (167 test)
npm test

# Modül bazlı
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
kernel.js        �?" �-�Yrenme, sorgulama, çıkarım, verify(), learnFromLLM()
graph.js         �?" Graf veri yapısı + SQLite/JSON çift katman
dream.js         �?" Hipotez motoru (node2vec embedding, benzerlik ke�Yfi)
llmAdapter.js    �?" Ollama + OpenAI wrapper ({ ok, data, error })
plugin.js        �?" Event-driven plugin sistemi
agent.js         �?" Goal planning + multi-step agent execution
cli.js           �?" Do�Yal dil parser + async LLM deste�Yi
server.js        �?" HTTP API + D3.js graf arayüzü + rate limiting
rustGraph.js     �?" Rust binary köprüsü (opsiyonel hızlandırıcı)
egitim.js        �?" Ba�Ylangıç e�Yitim verisi (mantık, felsefe, bilim)
```

---

## Hafıza

| Dosya | İçerik |
|---|---|
| `memory.db` | SQLite �?" dü�Yümler + kenarlar (WAL modu, crash-safe) |
| `memory.json` | JSON yedek �?" Rust katmanı ve fallback için |
| `memory.embeddings.json` | Node2Vec vektörleri (ayrı tutulur, �Yi�Ymeyi önler) |

SQLite varsayılan olarak aktif. Devre dı�Yı bırakmak için:

```js
const g = new Graph({ useSQLite: false });
```

---

## Plugin Sistemi

`plugins/` klasörüne `.js` dosyası bırak, otomatik yüklenir.

```js
// plugins/my-plugin.js
module.exports = {
  name: 'my-plugin',
  init(kernel) { /* ba�Ylangıç */ },
  beforeLearn(kernel, data) { /* data.text de�Yi�Ytirilebilir */ },
  afterLearn(kernel, data) { /* ö�Yrenme sonrası */ },
  beforeAsk(kernel, data) { /* data.question de�Yi�Ytirilebilir */ },
  afterAsk(kernel, data) { /* data.answer okunabilir */ },
  beforeDream(kernel, data) { },
  afterDream(kernel, data) { /* data.hypotheses */ },
  beforeEmbedding(kernel, opts) { /* opts.dimensions de�Yi�Ytirilebilir */ },
  afterEmbedding(kernel, result) { },
};
```

---

## Rust Hızlandırıcı (Opsiyonel)

`axiom-core/` dizininde Rust ile yazılmı�Y bir graf motoru bulunur. Rust binary varsa otomatik kullanılır, yoksa JS katmanına dü�Yer.

```bash
# Windows cross-compile
cd axiom-core
cargo build --release --target x86_64-pc-windows-gnu
```

---

## Gereksinimler

- Node.js >= 18
- `better-sqlite3` (npm ile otomatik kurulur)
- Ollama (opsiyonel, local LLM için)
- Rust toolchain (opsiyonel, hızlandırıcı için)

