# AXIOM

[![Tests](https://img.shields.io/badge/Tests-passing-green)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue)]()

AXIOM is a local-first symbolic reasoning core. It learns facts, verifies claims, detects contradictions, ranks evidence, and exposes the same engine through CLI, REST, MCP, workflow-agent runtime, and SDK wrapper layers.

## Current Status

- Core contract is stable: `ok`, `type`, `data`, `evidence`, `error`, `meta`
- Company Brain is shipped and exposed through ingest/query surfaces
- Workflow Agent OS is shipped and available as an opt-in runtime
- `AXIOM_AGENT_RUNTIME=workflow` enables the workflow agent stack
- `AXIOM_AGENT_VERSION=v3` keeps the checkpoint/resume agent available
- Discovery engine skeleton is shipped through workflow tools
- Product UI, Shield, ingest routing, demo smoke, and SDK wrappers are shipped in the v0.6 line
- v0.6.0 is the aligned release line for the productization and shield surface

## What AXIOM Does

- learns local facts into a graph
- verifies statements with evidence
- finds contradictions and manipulation risk
- tracks persistence in SQLite / JSON
- runs plugin capabilities through a strict contract
- exposes an Agent OS workflow path for tool orchestration

## Runtime Modes

### Default runtime

AXIOM uses the classic agent path by default.

### Workflow Agent OS

Set this environment variable to use the workflow runtime:

```bash
set AXIOM_AGENT_RUNTIME=workflow
```

The workflow runtime exposes these tools:

- `verifyClaim`
- `findContradictions`
- `rankEvidence`
- `repoMemory`
- `companyBrain`
- `discoveryEngine`
- `experimentPlanner`
- `resultAnalyzer`
- `replicationChecker`
- `runCapability`
- `getGraphStats`

### v3 agent

Set this environment variable to use the checkpoint/resume agent:

```bash
set AXIOM_AGENT_VERSION=v3
```

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

Agent OS:

- `mri: AXIOM company brain olmali`
- `tartis: AXIOM company brain olmali`
- `celiski: AXIOM motor degil ana urun olmali`

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

## Company Brain

Company Brain is shipped as the v0.4 line and is still the main ingest/query layer for company context.

Implemented files:

- `adapters/github-adapter.js`
- `adapters/markdown-adapter.js`
- `plugins/repo-memory.js`
- `plugins/company-brain.js`

Behavior:

- GitHub ingest uses native `fetch`, not Octokit
- markdown ingest is recursive
- manual ingest and decision log flows are supported
- ingest status tracks `repo / markdown / manual` distribution plus errors

## Workflow Agent OS

The v0.5 line ships an opt-in workflow stack:

- `workflow-agent.js` for deterministic plan/run execution
- `workflow-tools.js` for kernel/plugin adapters
- `workflow-runtime.js` for wiring the agent and tools together
- `repoMemory` and `companyBrain` are tools, not phases
- `discoveryEngine`, `experimentPlanner`, `resultAnalyzer`, and `replicationChecker` are the discovery skeleton tools

### SDK Wrappers

AXIOM exposes dependency-free wrappers for external AI systems:

- `lib/sdk.js` for `createAxiomClient`, `toLangChainTool`, and `toVercelAiMiddleware`
- `docs/sdk-v0.6.md` for the wrapper contract and out-of-scope notes

Supported SDK commands:

- `verify`
- `reason`
- `mri` / `ideaMRI`
- `devil` / `devilAdvocate`
- `contradictions` / `contradictionAlert`
- `shield`

### Demo Smoke

The v0.6 release smoke flow is documented in:

- `docs/demo-v0.6.md`

It covers:

- `GET /health`
- `GET /v2-status`
- `GET /graph-data`
- `POST /llm-sor`
- `POST /api/ingest`
- the product UI tabs and graph metadata

Use it when you want AXIOM to coordinate tools through a single runtime instead of invoking capabilities directly.

### v0.6 Release

The current release line is `v0.6.0`.

Release artifacts:

- `docs/v0.6-release-notes.md`
- `docs/demo-v0.6.md`
- `docs/sdk-v0.6.md`

### v0.7 Causal Branch

The causal reasoning line is isolated on `v0.7-causal-wip` and is not merged into `main` yet.

It adds:

- causal relations: `CAUSES`, `PREVENTS`, `ENABLES`, `DEPENDS_ON`, `LEADS_TO`
- deterministic causal traversal
- what-if simulation
- causal finalizer summaries
- the `autoLearn default true` demo scenario

Current scope:

- founder and builder decision simulation
- deterministic, symbolic, explainable output

Out of scope for the branch:

- full world model
- probabilistic prediction
- UI integration
- enterprise governance
- multi-user permissions and audit layers

Release candidate artifacts will be documented in:

- `docs/v0.7-release-notes.md`
- `docs/demo-causal-v0.7.md`

## Persistence

- `memory.db` - SQLite primary storage
- `memory.json` - JSON fallback
- `memory.embeddings.json` - embedding store

## Security Notes

- API key guard for write-heavy endpoints
- CORS restrictions for safe local origins
- request size limits and rate limiting
- Shield labels are explicit: `graph-backed`, `llm-assisted`, `unsupported`, `contradicted`

## Repository Layout

```text
kernel.js
kernel.v2.js
graph.js
plugin.js
agent.js
agent.v3.js
workflow-agent.js
workflow-tools.js
workflow-runtime.js
server.js
cli.js
mcpServer.js
adapters/
plugins/
benchmarks/
specs/
docs/
```

## License

MIT
