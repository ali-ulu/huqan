# Huqan — Think Without Hallucinating

> **Two modes. One engine. Zero hallucination.**

Huqan is a deterministic causal reasoning engine that works in two ways:

**⚡ Standalone** — No LLM, no GPU, no API key. Runs fully local. $0/query. Forever.

**🛡️ Verification Layer** — Put it in front of your LLM. It catches hallucinations before they reach the user.

Your choice. Same engine.

---

## Why Huqan?

LLMs are powerful — but they guess. Huqan doesn't guess.

When Huqan says *"Socrates is mortal"*, it's because it has:
- learned `Socrates is human`
- learned `humans are mortal`
- traced the causal chain — deterministically

No probability. No black box. Full evidence trail.

---

## Who is this for?

- **Developers** using LLMs who need a grounding/verification layer
- **Teams** in legal, medical, finance, engineering — where hallucination = liability
- **Anyone** who needs reasoning that runs fully offline, free, and explainable
- **Claude / Cursor users** — connect Huqan as a local MCP server

---

## How it works

```
             Input (user query or LLM output)
                          |
                          v
                    Huqan Kernel
                          |
                   [Causal Graph]
                          |
                   ┌──────┴──────┐
                   │   Known?    │
                   └──────┬──────┘
                Yes        │         No
                           │          │
                      Verify &    "Evidence
                      Confirm      missing."
                           │
                   ┌───────┴───────────┐
                   │  Contradiction?   │
                   └───────┬───────────┘
                Yes        │         No
                           │          │
                       Reject &    Learn &
                        Warn        Store
```

If evidence is missing → it says so.
If there's a contradiction → it rejects and explains why.
No guessing. Ever.

---

## Quick Start

```bash
npm install
node egitim.js    # Load initial knowledge base
node cli.js       # Interactive CLI
node server.js    # Web UI → http://localhost:3000
node mcpServer.js # MCP server for Claude Desktop / Cursor
```

> Node.js >= 18 required. No GPU. No API key.

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
| Works without LLM | ✅ Yes | ❌ N/A |
| Works with LLM | ✅ As a layer | ✅ Native |

---

## Causal Reasoning

Huqan understands causal relationships natively:

```
CAUSES      — A causes B
PREVENTS    — A prevents B
ENABLES     — A enables B
DEPENDS_ON  — A depends on B
LEADS_TO    — A leads to B
```

Ask Huqan why something happens — it traces the full causal chain, step by step.

---

## Two Modes in Practice

**Standalone:**
```bash
node cli.js
> kedi hayvandır        # teach
> kedi nedir            # ask → "kedi: hayvan, canlı"
> kedi bitkidir         # verify → "contradiction detected"
```

**As LLM verification layer:**
```
LLM says: "Socrates was born in 470 BC"
Huqan checks: known? → yes / contradiction? → no / confidence: 0.9
Result: ✅ verified
```

---

## MCP Server (Claude / Cursor) — Private Alpha

```bash
node mcpServer.js
```

Connect Huqan as a local MCP server to Claude Desktop or Cursor.

**Agent Brake Layer** — Every MCP tool call passes through 6 safety gates (AB1–AB6) before execution:
- Risk classification, tool authorization, code change verification
- Memory mutation approval, automation safety review, sandbox isolation
- Unknown tools are blocked by default
- Mutating tools (`axiom.learn`) require human review
- Agent loop (`axiom.agent`) runs in dry-run-only mode

```json
// Claude Desktop MCP config
{
  "axiom": {
    "mcp": { "command": "node", "args": ["mcpServer.js"] }
  }
}
```

→ See [`docs/demo-mcp-agent-brake-layer.md`](./docs/demo-mcp-agent-brake-layer.md) for full demo guide
→ See [`docs/local-install.md`](./docs/local-install.md) for setup instructions

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

---

## Obsidian Plugin

Use Huqan directly inside Obsidian to verify your notes and build a local knowledge graph from your vault.

→ See [`/obsidian-plugin`](./obsidian-plugin)

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

MIT — see [LICENSE](./LICENSE)

---

<p align="center">
  <b>huqan.com</b> · <a href="https://github.com/agiulucom42-del/axiom/issues">Issues</a> · <a href="https://github.com/agiulucom42-del/axiom/discussions">Discussions</a>
</p>
