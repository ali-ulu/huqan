# HUQAN

### Models generate. Agents act. Memory stores. **HUQAN judges.**

HUQAN is a **local-first AI governance, agent-safety, and verification layer** for claims, memory writes, and risky actions. It connects AI-assisted work to evidence, provenance, scope, policy, approval, and auditable Trust Receipts.

[![Version](https://img.shields.io/badge/version-v0.9.1-2563eb.svg)](./package.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-22c55e.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ali-ulu/huqan?style=flat&logo=github)](https://github.com/ali-ulu/huqan/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/ali-ulu/huqan?style=flat&logo=github)](https://github.com/ali-ulu/huqan/forks)
[![Open issues](https://img.shields.io/github/issues/ali-ulu/huqan?style=flat&logo=github)](https://github.com/ali-ulu/huqan/issues)
[![Last commit](https://img.shields.io/github/last-commit/ali-ulu/huqan?style=flat&logo=github)](https://github.com/ali-ulu/huqan/commits/main)

[Quick start](#quick-start) · [Why HUQAN](#why-huqan) · [How it works](#how-it-works) · [Ways to run](#ways-to-run) · [Current scope](#current-scope)

**Canonical repository:** `https://github.com/ali-ulu/huqan`

<p align="center">
  <img src="./docs/assets/huqan-agent-evidence-receipt-flow.svg" alt="HUQAN Agent–Evidence–Receipt flow" width="100%">
</p>

## What is HUQAN?

AI systems can produce useful outputs without showing:

- what source supports a claim,
- which workspace or scope applies,
- whether a risky action was approved,
- what changed later,
- or why a result was allowed, blocked, or escalated.

HUQAN adds a deterministic, auditable trust boundary around those decisions on its tested local paths.

```text
claim or action
      ↓
evidence + provenance + scope + policy
      ↓
verification + contradiction + risk gates
      ↓
ALLOW / BLOCK / ESCALATE
      ↓
Trust Receipt + audit context
```

HUQAN is not another LLM. Its core local graph, verification, gate, and receipt paths do not require a hosted model or cloud service.

## Why HUQAN?

| Need | HUQAN provides |
|---|---|
| **Repeatable decisions** | Deterministic verification and policy outcomes on tested paths |
| **Evidence traceability** | Provenance, graph evidence, reasoning context, and receipt links |
| **Safer AI agents** | Explicit review, block, escalation, and dry-run boundaries |
| **Protected memory** | Admission and workspace checks before canonical memory writes |
| **Auditability** | Trust Receipts and append-oriented audit records |
| **Local operation** | CLI, local server, and MCP flows without a required cloud dependency |

HUQAN is designed for AI governance, agent safety, LLM-output verification, approval workflows, provenance tracking, MCP integrations, and audit-ready AI-assisted work.

## Quick start

### Requirements

- Git
- npm
- **Node.js 20 or newer**
- Node.js 20 LTS or 22 LTS is recommended
- A compiler toolchain may be required if your platform cannot use a prebuilt `better-sqlite3` binary

> The current `better-sqlite3` dependency does not support Node.js 18. Earlier README text that advertised Node.js 18 was stale.

### Install from the canonical repository

Using HTTPS:

```bash
git clone https://github.com/ali-ulu/huqan.git
cd huqan
npm ci
```

Using GitHub CLI:

```bash
gh repo clone ali-ulu/huqan
cd huqan
npm ci
```

### Fix an existing clone that still points to an old repository name

```bash
git remote set-url origin https://github.com/ali-ulu/huqan.git
git remote -v
```

The `origin` fetch and push URLs should both be:

```text
https://github.com/ali-ulu/huqan.git
```

### Verify the local SQLite dependency and test suite

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('SQLite OK')"
npm test
```

### Start the CLI

```bash
npm start
```

Direct invocation remains available:

```bash
node cli.js
```

Example controlled statements:

```text
Smoking causes lung cancer
Vaccination prevents disease
Authentication enables secure access
Growth depends on investment
```

HUQAN currently handles explicit supported relation markers. It is not a general-purpose natural-language understanding engine.

## How it works

```mermaid
flowchart LR
    A[Agent or user output] --> B[Evidence and provenance]
    B --> C[Verification and contradiction checks]
    C --> D[Scope, policy, and risk gates]
    D -->|approved| E[Trusted state or permitted action]
    D -->|blocked or uncertain| F[Block or escalate]
    E --> G[Trust Receipt]
    F --> G
```

The main runtime layers are:

```text
CLI / REST / MCP / local UI
            ↓
agent routing and task dispatch
            ↓
safety gates and approval boundaries
            ↓
verification and graph reasoning
            ↓
provenance, receipts, and memory admission
            ↓
SQLite-backed local state and audit records
```

## Ways to run

### Local CLI

```bash
npm start
```

### Local REST server

Mutation endpoints require an API key.

```bash
AXIOM_API_KEY=replace-with-a-secret npm run server
```

`AXIOM_API_KEY` is the current compatibility environment-variable name used by the runtime. It is not the repository name.

The server starts at `http://localhost:3000`.

Useful endpoints:

| Endpoint | Method | Purpose |
|---|---:|---|
| `/health` | GET | Health check |
| `/api?q=...` | GET | Allowlisted read-only query surface |
| `/graph-data` | GET | Knowledge graph export |
| `/verify` | POST | Guarded verification |
| `/v2/verify` | POST | Guarded structured verification |
| `/upload` | POST | Guarded load alias |

Authenticated mutation requests use `X-API-Key` or `Authorization: Bearer <key>`.

### MCP server for Claude or Cursor

```bash
npm run mcp
```

Claude Desktop configuration:

```json
{
  "mcpServers": {
    "huqan": {
      "command": "node",
      "args": ["/absolute/path/to/huqan/mcpServer.js"]
    }
  }
}
```

## Core capabilities

- Graph-backed claim verification
- Contradiction detection
- Explicit `CAUSES`, `PREVENTS`, `ENABLES`, and `DEPENDS_ON` relations
- Memory admission and workspace isolation
- Risk classification and safety gates
- Approval flows for guarded actions
- Provenance and audit records
- Canonical Trust Receipts and receipt chains
- Portable `.axiom` package primitives
- CLI, REST, MCP, and local UI surfaces

## Current scope

HUQAN is currently a **local-first partial trust layer**.

What is real today:

- verification, graph, provenance, approval, audit, and receipt primitives,
- local CLI, REST, MCP, and UI surfaces,
- bounded memory and action gates,
- package and cryptographic foundations.

What this repository does **not** currently claim:

- universal truth or hallucination elimination,
- complete inline enforcement for every connector and mutation path,
- a finished V5 shared-trust ecosystem,
- a public agent marketplace or certification network,
- Wikipedia-scale graph performance,
- a complete autonomous Self-Healer.

For the live execution order and exact limitations, read [docs/current-operating-roadmap.md](./docs/current-operating-roadmap.md).

## Repository map

| Path | Purpose |
|---|---|
| `kernel.js`, `graph.js` | Verification and graph reasoning core |
| `lib/` | Gates, provenance, memory, receipts, viewers, and supporting modules |
| `cli.js` | Local command-line interface |
| `server.js` | Local REST server and UI delivery |
| `mcpServer.js` | MCP integration |
| `public/` | Backend-connected local UI |
| `demo/` | Static public demo |
| `test/` and `*.test.js` | Automated test coverage |
| `docs/` | Architecture, audits, product boundaries, and roadmap |

## Development

```bash
npm test
npm run bench
npm run bench:verify
```

Focused test commands are available in [`package.json`](./package.json).

## Documentation and support

- [Current operating roadmap](./docs/current-operating-roadmap.md)
- [Product surfaces](./docs/product-surfaces.md)
- [Competitive positioning](./docs/competitive-positioning.md)
- [NLP boundary](./docs/nlp-boundary.md)
- [Scale truth pack](./docs/scale-truth-pack.md)
- [Governance](./docs/governance.md)
- [Security policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)
- [Issues](https://github.com/ali-ulu/huqan/issues)
- [Discussions](https://github.com/ali-ulu/huqan/discussions)

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

---

**HUQAN:** trust and evidence infrastructure for AI-mediated work.
