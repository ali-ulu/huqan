# Huqan

### Models generate. Agents act. Memory stores. HUQAN judges.

**A local-first, deterministic judgment and verification layer for AI claims, memory, and actions.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-green.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](https://nodejs.org)

[Quick Start](#quick-start) · [Architecture](#architecture) · [Safety Gates](#safety-gates) · [MCP Server](#mcp-server-claude--cursor) · [API](#rest-api) · [Roadmap](#roadmap)

---

## The Problem

LLMs can produce unsupported or contradictory answers. In regulated industries - healthcare, finance, legal, engineering - a confident wrong answer is dangerous and expensive.

Many guardrail systems are probabilistic: they use another model to inspect the first one. That can help, but it does not create a deterministic trust boundary by itself.

**HUQAN takes a different approach: repeatable judgments with receipts, graph evidence, and action gates.**

For tested current-main paths, the core verdict flow does not rely on LLM-as-judge behavior.

---

## What Huqan Does

| Capability | How It Works |
|---|---|
| **Judges Claims** | Produces deterministic verification results from graph-backed evidence and current trust rules |
| **Checks Memory Writes** | Admission and workspace boundaries protect canonical memory writes from silent drift |
| **Gates Risky Actions** | Policy and trust gates classify review, block, and dry-run-only paths before execution |
| **Emits Receipts** | Trust Receipt and reasoning metadata preserve why a result was allowed, blocked, or downgraded |
| **Supports Local Integrations** | MCP, CLI, and local server flows can run against the same local trust boundary |
| **Runs Local-First** | No cloud dependency is required for the core local graph, verification, and gate paths |

---

## Comparison

| Feature | HUQAN | LLM-only | Guardrail-only stack |
|---|---|---|---|
| Core verdict path | Deterministic for tested current-main paths | Model-dependent | Usually policy or model-dependent |
| Contradiction handling | Graph and verifier backed | Not inherent | Varies by implementation |
| Local-first operation | Supported | Usually API-backed | Varies by implementation |
| Receipts / audit trail | Built into trust flows | Usually absent | Often partial |
| Risky action gating | Explicit review / block / dry-run paths | Usually external | Policy-oriented |
| Relation extraction | Explicit marker extraction, not full NLP | Model inference | Usually not primary focus |
| Current limits | Partial trust layer, documented checkpoints | Model variance | Coverage varies by product |

---

## Quick Start

```bash
git clone https://github.com/agiulucom42-del/axiom.git
cd axiom
npm ci --include=optional

node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('better-sqlite3 db ok')"
npm test

node egitim.js
node cli.js
node server.js
node mcpServer.js
```

> Requirements: Node.js >= 18. Use `npm ci --include=optional` for deterministic installs with the local SQLite path enabled.

## Product Surfaces

- `demo/index.html` is the canonical static public demo surface.
- `public/index.html` is the canonical local backend-connected UI served by `node server.js`.
- `docs/index.html` is the docs/demo chooser, not a competing product page.

See [docs/product-surfaces.md](./docs/product-surfaces.md) for the explicit surface policy.

## Competitive Positioning

- HUQAN is a local-first judgment and verification layer, not another model or chat wrapper.
- The public story should stay centered on deterministic judgment, receipts, and safe decision support.
- Product messaging, demo framing, and pitch language live in [docs/competitive-positioning.md](./docs/competitive-positioning.md), [docs/demo-positioning.md](./docs/demo-positioning.md), and [docs/pitch-v0.md](./docs/pitch-v0.md).

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

## NLP Boundary

- `nlp/lang-tr.js` is a simple deterministic parser for controlled statements.
- It is not a full Turkish NLP engine and should not be presented as general semantic understanding.
- Parser limits, safe examples, and the optional adapter strategy are documented in [docs/nlp-boundary.md](./docs/nlp-boundary.md).

## Current Verified State

- Explicit marker relation extraction is checkpointed for `CAUSES`, `PREVENTS`, `DEPENDS_ON`, and `ENABLES`, including Turkish `DEPENDS_ON` variants.
- Shield now verifies the full LLM response window instead of only the first 300 characters.
- Memory lookup now fails closed when `workspaceId` is missing instead of scanning across workspaces.
- Self-Healer contract and safety matrix docs exist, but runtime Self-Healer implementation remains planned.
- Recent hardening and relation extraction checkpoints are documented under [docs/audits](./docs/audits).

---

## Architecture

```text
Surface Layer      -> CLI, REST API, Web UI
Agent Layer        -> query routing, task dispatch
Safety Layer       -> AB1-AB6 gates, risk classification
Kernel Layer       -> verify, learn, graph-backed reasoning
Trust Layer        -> provenance, receipts, admission
Relation Layer     -> explicit CAUSES / PREVENTS / ENABLES / DEPENDS_ON markers
Memory/Data Layer  -> SQLite store, append-only audit trail
```

Each layer is independently testable. The Safety Layer and Kernel can run without the full stack.

---

## Safety Gates

HUQAN classifies risky behavior through deterministic gates:

| Gate | Function | Example Catch |
|---|---|---|
| **AB1** | Harmful content detection | "How to make a bomb" |
| **AB2** | PII / sensitive data leak | SSN, medical records in output |
| **AB3** | Instruction injection | Prompt-injection attempts |
| **AB4** | Code change risk assessment | Destructive SQL / shell commands |
| **AB5** | Tool-call gating | Unauthorized API calls |
| **AB6** | Cross-gate risk aggregation | Combined risk scoring |

Core gate outcomes are deterministic policy judgments such as `ALLOW`, `BLOCK`, or `ESCALATE`.

---

## Relation Reasoning

HUQAN supports explicit relation extraction and graph reasoning for patterns such as:

```text
CAUSES      - Smoking causes lung cancer
PREVENTS    - Vaccination prevents disease
ENABLES     - Authentication enables secure access
DEPENDS_ON  - Growth depends on investment
```

For explicit supported markers, HUQAN can trace relation paths step by step with evidence at each link. This is explicit marker extraction, not a general-purpose NLP engine.

---

## MCP Server (Claude / Cursor)

Connect HUQAN as a local MCP server to give your AI assistant a deterministic verification layer:

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

Tested local MCP paths use the same gate semantics for read, review, block, and dry-run decisions.

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
| `/yukle` | POST | Required | Guarded load endpoint |

**Auth:** Mutation endpoints require `AXIOM_API_KEY` on the server and `X-API-Key` or `Authorization: Bearer <key>` header.

**Public surface note:** `demo/index.html` is the canonical static public demo. `public/index.html` is the canonical local backend-connected UI served by `node server.js`. `docs/index.html` is a chooser page, not a third product surface.

---

## Obsidian Plugin

Use HUQAN inside Obsidian to verify notes and build a local knowledge graph from a vault.

See [`/obsidian-plugin`](./obsidian-plugin).

---

## Use Cases

| Industry | Application |
|---|---|
| **Healthcare** | Verify drug interaction claims against known causal data |
| **Finance** | Gate LLM outputs that could trigger unauthorized transactions |
| **Legal** | Detect contradictions in contract analysis outputs |
| **Engineering** | Validate safety-critical claims with deterministic judgments and receipts |
| **Compliance** | Preserve audit evidence for AI-assisted decisions |

---

## Verified Runtime Notes

- Memory Core compatibility and workspace invariants remain part of the current mainline.
- Relation extraction and security hardening closures are tracked in dated audit checkpoints.
- For the latest validated state, prefer the checkpoint docs over stale README snapshots.

---

## Roadmap

- [x] Causal graph engine
- [x] Contradiction detection
- [x] MCP server (Claude / Cursor)
- [x] Obsidian plugin
- [x] Trust Receipts (ATP v0.1)
- [x] Safety gates AB1-AB6
- [ ] Standalone Safety Gate package (`@huqan/safety-gate`)
- [ ] npm package distribution
- [ ] A2A Internal Exchange (agent-to-agent task economy)
- [ ] Distributed trust layer
- [ ] Self-Healer audit loop (planned)
- [ ] Public API with rate limiting

---

## Philosophy

Most AI tools try to make models answer more.
We're building a layer that judges claims, memory writes, and risky actions before they become trusted state.

> *"Models generate. Agents act. Memory stores. HUQAN judges."*

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## Governance and contribution

- The project is maintainer-led and human-reviewed.
- AI-assisted contributions are allowed, but they must be reviewed before merge.
- Security-sensitive changes require explicit approval.
- Release tags require clean test and smoke gates.
- See [CONTRIBUTING.md](./CONTRIBUTING.md), [docs/governance.md](./docs/governance.md), and [SECURITY.md](./SECURITY.md).

## Launch UAT and Demo

- [Launch UAT](./docs/launch-uat.md)
- [Demo Script](./docs/v4/v4-demo-script.md)
- Static demo surface: `demo/index.html`
- Local UI surface: `public/index.html`

## License

Apache License 2.0 - see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)

This project was previously licensed under AGPL-3.0. The license was changed to Apache 2.0
to enable broader adoption, including enterprise use and proprietary integration.
For commercial licensing inquiries, please open an issue.

---

**huqan.ai** · [Issues](https://github.com/agiulucom42-del/axiom/issues) · [Discussions](https://github.com/agiulucom42-del/axiom/discussions)
