# AXIOM

[![Tests](https://img.shields.io/badge/Tests-291%2F291-green)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue)]()

Deterministic symbolic reasoning engine.
AXIOM verifies claims, detects contradictions, tracks evidence, and keeps local memory.

## What It Is

AXIOM is a local-first reasoning core with:
- knowledge graph learning
- contradiction detection
- evidence-aware verification
- plugin capability system
- optional LLM-assisted flows
- agent runtime (v2/v3 runtime selectable)

## Current Status

- Core contract: stable (`ok`, `type`, `data`, `evidence`, `error`, `meta`)
- Test status: `291/291`
- v0.4 company-brain ingestion: implemented

## Quick Start

```bash
npm install
npm test
npm run server
```

CLI:

```bash
npm start
```

MCP server:

```bash
npm run mcp
```

## CLI Commands

General:
- `ogret: kedi hayvandir`
- `sor: kedi nedir`
- `plan: hedef`
- `ajan: hedef`
- `durum`
- `backup`
- `restore`

Company ingest/query:
- `ogren --kaynak manuel --yazar sonfi "kedi hayvandir"`
- `ogren --kaynak karar --baslik "X" --gerekce "Y"`
- `sirket-sor: Bu karar neden alindi?`
- `ingest-durum`

## REST Endpoints

Verification:
- `GET /v2/verify?statement=...`
- `POST /v2/verify`
- Legacy: `GET/POST /dogrula`

Ingest:
- `POST /api/ingest`
- `GET /api/ingest/status`

System:
- `GET /health`
- `GET /v2-status`
- `GET /graph-data`

## v0.4 Company Brain Scope

Implemented files:
- `adapters/github-adapter.js`
- `adapters/markdown-adapter.js`
- `plugins/repo-memory.js`
- `plugins/company-brain.js`

Behavior:
- GitHub ingest via native `fetch` (no Octokit)
- recursive markdown ingest
- manual ingest and decision log
- ingest status reporting (`repo/markdown/manual` distribution + error list)

## Persistence

- `memory.db` (SQLite, primary)
- `memory.json` (JSON fallback)
- `memory.embeddings.json` (embedding store)

## Security Notes

- API key guard for write-heavy endpoints
- CORS restrictions for safe local origins
- request size limits and rate limiting

## Project Layout

```text
kernel.js
kernel.v2.js
graph.js
plugin.js
agent.js
agent.v3.js
server.js
cli.js
mcpServer.js
adapters/
plugins/
benchmarks/
```

## License

MIT
