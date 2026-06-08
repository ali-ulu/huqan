<div align="center">

# ⚡ Huqan — Think Without Hallucinating

**Deterministic causal reasoning engine. No LLM. No GPU. No hallucination.**

[![npm version](https://img.shields.io/npm/v/axiom?color=blue&style=flat-square)](https://www.npmjs.com/package/axiom)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-1177%2F1222-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)]()
[![GitHub stars](https://img.shields.io/github/stars/agiulucom42-del/axiom?style=social)]()

</div>

---

> **Two modes. One engine. Zero hallucination.**

Huqan is a deterministic causal reasoning engine that works in two ways:

**🟢 Standalone** — No LLM, no GPU, no API key. Runs fully local. $0/query. Forever.

**🟡 Verification Layer** — Put it in front of your LLM. It catches hallucinations before they reach the user.

Your choice. Same engine.

---

## Features

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
                   ┌─────────────┐
                   │   Known?    │
                   └─────────────┘
                /               \
              Yes                No
               |                  |
           Verify &          "Evidence
           Confirm            missing."
               |
           ┌─────────────────┐
           │ Contradiction?   │
           └─────────────────┘
          /                   \
        Yes                    No
         |                      |
     Reject &               Learn &
      Warn                   Store
```

If evidence is missing — it says so.
If there's a contradiction — it rejects and explains why.
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

## CLI Reference

| Command | Description |
|---|---|
| `node cli.js` | Interactive CLI — ask, teach, verify |
| `node server.js` | REST API server at localhost:3000 |
| `node mcpServer.js` | MCP server for Claude/Cursor integration |
| `node egitim.js` | Load initial knowledge base |
| `node backupRestore.js` | Backup or restore memory graph |
| `npm test` | Run full test suite (110+ test files) |

### CLI Interactive Commands

Inside `node cli.js`:

| Command | Example | Description |
|---|---|---|
| `[statement]` | `kedi hayvandir` | Teach a fact |
| `?[query]` | `?kedi nedir` | Ask a question |
| `![statement]` | `!kedi bitkidir` | Verify a claim |
| `/export` | — | Export graph as JSON |

---

## Causal Reasoning

Huqan understands causal relationships natively:

| Relation | Meaning | Example |
|---|---|---|
| **CAUSES** | A causes B | `smoking CAUSES cancer` |
| **PREVENTS** | A prevents B | `vaccine PREVENTS disease` |
| **ENABLES** | A enables B | `API_key ENABLES access` |
| **DEPENDS_ON** | A depends on B | `app DEPENDS_ON database` |
| **LEADS_TO** | A leads to B | `study LEADS_TO degree` |

Ask Huqan why something happens — it traces the full causal chain, step by step.

---

## Two Modes in Practice

**Standalone:**
```bash
node cli.js
> kedi hayvandir        # teach
> kedi nedir            # ask → "kedi: hayvan, canli"
> kedi bitkidir         # verify → "contradiction detected"
```

**As LLM verification layer:**
```
LLM says: "Socrates was born in 470 BC"
Huqan checks: known? → yes / contradiction? → no / confidence: 0.9
Result: ✅ verified
```

---

## MCP Server (Claude / Cursor)

```bash
node mcpServer.js
```

Connect Huqan as a local MCP server to Claude Desktop or Cursor.

**Agent Brake Layer** — Every MCP tool call passes through 6 safety gates (AB1-AB6):
- Risk classification, tool authorization, code change verification
- Memory mutation approval, automation safety review, sandbox isolation
- Unknown tools are blocked by default
- Mutating tools (`axiom.learn`) require human review
- Agent loop (`axiom.agent`) runs in dry-run-only mode

```json
{
  "mcpServers": {
    "axiom": {
      "command": "node",
      "args": ["mcpServer.js"]
    }
  }
}
```

📖 See [`docs/demo-mcp-agent-brake-layer.md`](./docs/demo-mcp-agent-brake-layer.md)
📖 See [`docs/local-install.md`](./docs/local-install.md)

---

## REST API

```bash
node server.js
# → http://localhost:3000
```

| Endpoint | Method | Description |
|---|---|---|
| `/api?q=query` | GET | Ask a question |
| `/dogrula` | POST | Verify a statement |
| `/yukle` | POST | Load text into knowledge base |
| `/graph-data` | GET | Export the knowledge graph |

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

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

- 🐛 Found a bug? [Open an issue](https://github.com/agiulucom42-del/axiom/issues)
- 💡 Have an idea? [Start a discussion](https://github.com/agiulucom42-del/axiom/discussions)
- 🔀 Want to contribute? PRs are reviewed within 48 hours

See [CHANGELOG.md](./CHANGELOG.md) for version history.

---

## License

MIT — see [LICENSE](./LICENSE)

---

<p align="center">
  <a href="https://huqan.com">huqan.com</a> &nbsp;·&nbsp;
  <a href="https://github.com/agiulucom42-del/axiom/issues">Issues</a> &nbsp;·&nbsp;
  <a href="https://github.com/agiulucom42-del/axiom/discussions">Discussions</a> &nbsp;·&nbsp;
  <a href="https://github.com/agiulucom42-del/axiom/blob/main/CHANGELOG.md">Changelog</a>
</p>