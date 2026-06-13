<div align="center">

# Huqan

### Think Without Hallucinating

**A deterministic causal reasoning engine that verifies claims — no LLM, no GPU, no cloud.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-green.svg)](https://opensource.org/licenses/Apache-2.0)
[![Tests](https://img.shields.io/badge/tests-1434%20pass-brightgreen)](./test)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](https://nodejs.org)

[Quick Start](#quick-start) · [Architecture](#architecture) · [Safety Gates](#safety-gates) · [MCP Server](#mcp-server-claude--cursor) · [API](#rest-api) · [Roadmap](#roadmap)

</div>

---

## The Problem

LLMs hallucinate. In regulated industries — healthcare, finance, legal, engineering — a confident wrong answer isn't just annoying. It's **dangerous** and **expensive**.

Existing guardrails are probabilistic: they use another LLM to check the first LLM. That's using fire to fight fire.

**Huqan takes a different approach: deterministic verification.**

Same input → same output. Every time. No probability, no guessing, no hallucination.

---

## What Huqan Does

| Capability | How It Works |
|---|---|
| **Claim Verification** | Checks claims against a causal knowledge graph — deterministic, reproducible |
| **Contradiction Detection** | Finds logical conflicts between claims using causal relation analysis |
| **Safety Gating** | AB1–AB6 gates intercept dangerous LLM outputs before they reach users |
| **Audit Trail** | Every operation is logged with provenance — who, what, when, why |
| **MCP Integration** | Plug into Claude Desktop, Cursor, or any MCP-compatible client |
| **Offline First** | No API keys, no cloud, no cost per query — runs entirely local |

---

## Comparison

| Feature | Huqan | LLM-only | Guardrails AI |
|---|---|---|---|
| Deterministic answers | ✅ Always | ❌ Never | ⚠️ Partial |
| Contradiction detection | ✅ Built-in | ❌ No | ⚠️ Heuristic |
| Runs fully offline | ✅ Yes | ❌ Needs API | ❌ Needs API |
| GPU required | ❌ No | ✅ Yes | ❌ No |
| Cost per query | **$0** | $/query | $/query |
| Explainable reasoning | ✅ Full trace | ❌ Black box | ⚠️ Limited |
| Causal chains | ✅ CAUSES, PREVENTS, ENABLES… | ❌ No | ❌ No |
| Provenance / Audit | ✅ Append-only | ❌ No | ❌ No |

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/agiulucom42-del/axiom.git
cd axiom
npm ci --include=optional

# Verify local runtime
node -e "require('better-sqlite3'); console.log('better-sqlite3 ok')"
npm test

# Load initial knowledge base
node egitim.js

# Interactive CLI
node cli.js

# English-first CLI examples
# learn: cats are animals
# ask: cat nedir
# verify: kedi bitkidir

# Web UI (http://localhost:3000)
node server.js

# MCP Server for Claude Desktop / Cursor
node mcpServer.js
```

> **Requirements:** Node.js >= 18. Use `npm ci --include=optional` for deterministic installs with the local SQLite path enabled.

## Product Surfaces

- `demo/index.html` is the canonical static public demo surface.
- `public/index.html` is the canonical local backend-connected UI served by `node server.js`.
- `docs/index.html` is the docs/demo chooser, not a competing product page.

See [docs/product-surfaces.md](./docs/product-surfaces.md) for the explicit surface policy.

## Scale Truth

- Current benchmark fixtures cover small-to-medium graphs only.
- Largest existing benchmark fixture: `xlarge` with 140 nodes and 131 edges in `benchmarks/results.json`.
- Larger graph support requires dedicated benchmarking; it is not yet proven at Wikipedia-scale.
- See [docs/scale-truth-pack.md](./docs/scale-truth-pack.md) for the measured status and safe public language.

## English-first Developer UX

- Public docs use English-first command examples.
- Turkish commands remain supported for compatibility.
- English aliases are the recommended path for global developers.
- Guarded API examples use `POST /verify`, `POST /v2/verify`, and `POST /upload`.
- Unsafe GET verification is not supported; `GET /verify`, `GET /dogrula`, and `GET /v2/verify` return `405 Method Not Allowed`.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Surface Layer                   │
│            (CLI, REST API, Web UI)               │
├─────────────────────────────────────────────────┤
│                  Agent Layer                      │
│          (Query routing, task dispatch)           │
├─────────────────────────────────────────────────┤
│                 Safety Layer                      │
│          AB1–AB6 gates, risk classification       │
├─────────────────────────────────────────────────┤
│                 Kernel Layer                      │
│      Verify, learn, causal graph engine           │
├─────────────────────────────────────────────────┤
│                 Trust Layer                       │
│       ATP protocol, provenance receipts           │
├─────────────────────────────────────────────────┤
│                Causal Layer                       │
│   CAUSES / PREVENTS / ENABLES / DEPENDS_ON        │
├─────────────────────────────────────────────────┤
│            Memory + Data Layer                    │
│     SQLite store, append-only audit trail         │
└─────────────────────────────────────────────────┘
```

Each layer is independent and testable. The **Safety Layer** and **Kernel** can operate standalone — no need to run the full stack.

---

## Safety Gates

Huqan's safety system intercepts and classifies LLM outputs through six deterministic gates:

| Gate | Function | Example Catch |
|---|---|---|
| **AB1** | Harmful content detection | "How to make a bomb" |
| **AB2** | PII / sensitive data leak | SSN, medical records in output |
| **AB3** | Instruction injection | Prompt-injection attempts |
| **AB4** | Code change risk assessment | Destructive SQL / shell commands |
| **AB5** | Tool-call gating | Unauthorized API calls |
| **AB6** | Cross-gate risk aggregation | Combined risk scoring |

Every gate produces a **deterministic verdict**: `ALLOW`, `BLOCK`, or `ESCALATE`. No probability, no ambiguity.

---

## Causal Reasoning

Huqan understands and reasons about causal relationships:

```
CAUSES      - Smoking causes lung cancer
PREVENTS    - Vaccination prevents disease
ENABLES     - Education enables opportunity
DEPENDS_ON  - Growth depends on investment
LEADS_TO    - Neglect leads to failure
```

Ask "why?" and Huqan traces the full causal chain — step by step, with evidence at every link.

---

## MCP Server (Claude / Cursor)

Connect Huqan as a local MCP server to give your AI assistant a deterministic verification layer:

```bash
node mcpServer.js
```

**Claude Desktop config** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "huqan": {
      "command": "node",
      "args": ["/path/to/axiom/mcpServer.js"]
    }
  }
}
```

Your AI assistant now verifies its own outputs against Huqan's knowledge graph before answering.

---

## REST API

```bash
node server.js  # Starts at http://localhost:3000
```

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | Public | Health check |
| `/v2-status` | GET | Public | V2 status |
| `/api?q=query` | GET | Public | Read-only allowlisted query surface |
| `/verify?statement=...` | GET | Public | `405 Method Not Allowed` |
| `/dogrula?statement=...` | GET | Public | `405 Method Not Allowed` |
| `/v2/verify?statement=...` | GET | Public | `405 Method Not Allowed` |
| `/graph-data` | GET | Public | Export knowledge graph |
| `/verify` | POST | Required | Guarded verification endpoint |
| `/dogrula` | POST | Required | Guarded verification endpoint |
| `/v2/verify` | POST | Required | Guarded structured verification endpoint |
| `/upload` | POST | Required | English alias for guarded load endpoint |
| `/yukle` | POST | Required | Load knowledge base |

**Auth:** Mutation endpoints require `AXIOM_API_KEY` on the server and `X-API-Key` or `Authorization: Bearer <key>` header.

**Public surface note:** `demo/index.html` is the canonical static public demo. `public/index.html` is the canonical local backend-connected UI served by `node server.js`. `docs/index.html` is a chooser page, not a third product surface.

**Response format:**
```json
{
  "status": "verified" | "contradiction" | "unknown",
  "confidence": 0.9,
  "evidence": ["..."],
  "provenance": { "source": "...", "timestamp": "..." }
}
```

---

## Obsidian Plugin

Use Huqan directly inside Obsidian to verify your notes and build a local knowledge graph from your vault.

📁 See [`/obsidian-plugin`](./obsidian-plugin)

---

## Use Cases

| Industry | Application |
|---|---|
| **Healthcare** | Verify drug interaction claims against known causal data |
| **Finance** | Gate LLM outputs that could trigger unauthorized transactions |
| **Legal** | Detect contradictions in contract analysis outputs |
| **Engineering** | Validate safety-critical claims with deterministic reasoning |
| **Compliance** | Full audit trail for every AI-assisted decision (GDPR, SOX, HIPAA) |

---

## v0.9.1 — Memory Core

AXIOM v0.9.1 ships from `main` with Memory Core compatibility aligned through PR #42.

- Deterministic memory behavior preserved
- Normalized SQLite `MemoryStore` architecture
- Memory Core compatibility aliases on `kernel.memory`
- Provenance, audit, and workspace invariants in place
- Test suite: **1277 pass / 0 fail / 16 skipped**

---

## Roadmap

- [x] Causal graph engine
- [x] Contradiction detection
- [x] MCP server (Claude / Cursor)
- [x] Obsidian plugin
- [x] Trust Receipts (ATP v0.1)
- [x] Safety gates AB1–AB6
- [ ] Standalone Safety Gate package (`@huqan/safety-gate`)
- [ ] npm package distribution
- [ ] A2A Internal Exchange (agent-to-agent task economy)
- [ ] Distributed trust layer
- [ ] Self-healer audit loop (v0.9.2)
- [ ] Public API with rate limiting

---

## Philosophy

Most AI tools try to make LLMs remember more.  
We're building something that **doesn't need to guess**.

> *"While everyone is building better memory for LLMs, we removed the LLM."*

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)

This project was previously licensed under AGPL-3.0. The license was changed to Apache 2.0
to enable broader adoption, including enterprise use and proprietary integration.
For commercial licensing inquiries, please open an issue.

---

<div align="center">

**huqan.ai** · [Issues](https://github.com/agiulucom42-del/axiom/issues) · [Discussions](https://github.com/agiulucom42-del/axiom/discussions)

</div>
