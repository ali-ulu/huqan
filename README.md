# Huqan - Think Without Hallucinating

> **LLM outputs lie. Huqan doesn't.**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![README Score](https://github.com/agiulucom42-del/axiom/actions/workflows/readme-score.yml/badge.svg)](https://github.com/agiulucom42-del/axiom/actions/workflows/readme-score.yml)

Huqan is a deterministic causal reasoning engine.  
No LLM. No GPU. No cloud. No hallucination.

---

## Who is this for?

- **Developers** building on top of LLMs who need a truth/verification layer
- **Teams** in critical domains (legal, medical, finance, engineering) where hallucination is not acceptable
- **Anyone** who needs reasoning that runs fully offline - no API key, no cloud, no cost per query
- **Claude / Cursor users** who want a local MCP server for grounded, verifiable answers

---

## How it works

```
User / LLM Output
       |
       v
   Huqan Kernel
       |
  [Causal Graph]
       |
  +-----------+
  | Known?    |
  +-----------+
   Yes       No
    |        |
  Verify    "Evidence
  &         missing."
  Confirm
    |
  +-----------------+
  | Contradiction?  |
  +-----------------+
   Yes             No
    |              |
  Reject &       Learn &
   Warn          Store
```

Huqan builds a **causal knowledge graph** from what it learns.  
When a claim arrives, it checks it deterministically - no probability, no guessing.  
If evidence is missing, it says so. If there's a contradiction, it rejects and explains why.

---

## Quick Start

```bash
npm install
node egitim.js    # Load initial knowledge base
node cli.js       # Interactive CLI
node server.js    # Web UI at http://localhost:3000
node mcpServer.js # MCP server for Claude Desktop / Cursor
```

> Node.js >= 18 required.

---

## Core Features

| Feature | Huqan | LLM-only |
|---|---|---|
| Deterministic answers | ✅ Always | ❌ Never |
| Contradiction detection | ✅ Built-in | ❌ No |
| Runs offline | ✅ Fully | ❌ Needs API |
| GPU required | ❌ No | ✅ Yes |
| Cost per query | $0 | $/query |
| Explainable reasoning | ✅ Full trace | ❌ Black box |
| Causal chains | ✅ CAUSES, PREVENTS, ENABLES... | ❌ No |
| Validation F1 | 0.88-0.91 | 0.82-0.86 |

---

## Causal Reasoning

Huqan understands causal relationships:

```
CAUSES      - A causes B
PREVENTS    - A prevents B
ENABLES     - A enables B
DEPENDS_ON  - A depends on B
LEADS_TO    - A leads to B
```

Ask Huqan why something happens - it traces the full causal chain, step by step.

---

## MCP Server (Claude / Cursor)

```bash
node mcpServer.js
```

Connect Huqan as a local MCP server to Claude Desktop or Cursor.  
Your AI assistant will verify its own outputs against Huqan's knowledge graph before answering.

---

## REST API

```bash
node server.js  # http://localhost:3000
```

| Endpoint | Description |
|---|---|
| `GET /api?q=query` | Ask a question |
| `POST /dogrula` | Verify a statement |
| `POST /yukle` | Load text into knowledge base |
| `GET /graph-data` | Export the knowledge graph |

Response: `{ "status": "verified" | "contradiction" | "unknown", "confidence": 0.9, "evidence": [...] }`

---

## Obsidian Plugin

Use Huqan directly inside Obsidian to verify your notes and build a local knowledge graph from your vault.

📁 See [`/obsidian-plugin`](./obsidian-plugin)

---

## Roadmap

- [x] Causal graph engine
- [x] Contradiction detection
- [x] MCP server
- [x] Obsidian plugin
- [x] Trust Receipts (ATP v0.1)
- [ ] A2A Internal Exchange (agent-to-agent task economy)
- [ ] Distributed trust layer
- [ ] Public API

---

## Philosophy

Most AI tools are trying to make LLMs remember more.  
We're building something that **doesn't need to guess**.

> *"While everyone is building better memory for LLMs, we removed the LLM."*

---

## License

AGPL-3.0 - see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)

---

<p align="center">
  <b>huqan.ai</b> · <a href="https://github.com/agiulucom42-del/axiom/issues">Issues</a> · <a href="https://github.com/agiulucom42-del/axiom/discussions">Discussions</a>
</p>
