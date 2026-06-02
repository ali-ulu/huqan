# AXIOM Architecture

## Source of Truth

Use this file as the compact map before making product or architecture claims about AXIOM.

Detailed behavior still lives in tests and code. This document exists to avoid re-reading the whole repository for every high-level decision.

## Core Modules

### Graph Memory

Primary file:

- `graph.js`

Responsibilities:

- node and edge storage
- SQLite primary persistence
- JSON fallback compatibility
- causal relation schema
- deterministic causal traversal

Important relation groups:

- legacy graph relations
- causal relations: `CAUSES`, `PREVENTS`, `ENABLES`, `DEPENDS_ON`, `LEADS_TO`

### Kernel

Primary files:

- `kernel.js`
- `kernel.v2.js`

Responsibilities:

- fact learning
- claim verification
- plugin/capability access
- graph-backed reasoning surface

### Trust Kernel (v0.8 direction)

Primary docs:

- `docs/ADR-002-trust-kernel-and-atp.md`
- `specs/axiom-trust-protocol/0.1/README.md`

Responsibilities:

- provenance and source binding
- trust policy evaluation
- append-only audit routing
- workspace-aware claim handling
- ATP and AVP contract surface

Current note:

- PR-0 is docs-only
- runtime is intentionally unchanged in this step

### Shield

Primary file:

- `lib/shield.js`

Responsibilities:

- classify LLM-assisted responses
- keep `autoLearn` defaulting to `false`
- prevent unsupported and contradicted output from becoming trusted memory

Public labels:

- `graph-backed`
- `llm-assisted`
- `unsupported`
- `contradicted`

### Ingest

Primary file:

- `lib/ingest.js`

Responsibilities:

- route `sourceType` payloads
- normalize ingest input
- call Company Brain and Repo Memory capabilities
- prepare idempotency fields

### Causal Simulator

Primary file:

- `causalSimulator.js`

Responsibilities:

- consume deterministic causal chains
- calculate affected nodes
- produce risk, confidence, evidence, and recommendation
- remain LLM-free and deterministic

### Finalizer

Primary file:

- `finalizer.js`

Responsibilities:

- convert tool and simulation results into structured judgment
- preserve known facts, unknowns, evidence, conclusion, and next questions
- emit causal summaries with traversal metadata

### Workflow Runtime

Primary files:

- `workflow-agent.js`
- `workflow-tools.js`
- `workflow-runtime.js`

Responsibilities:

- deterministic plan/run execution
- tool orchestration
- discovery skeleton wiring

### SDK

Primary file:

- `lib/sdk.js`

Responsibilities:

- dependency-free client wrapper
- LangChain tool wrapper
- Vercel AI middleware wrapper

## Product Surfaces

- CLI: `cli.js`
- REST server: `server.js`
- MCP server: `mcpServer.js`
- Product UI: `public/index.html`
- SDK: `lib/sdk.js`

## Verification Commands

Core release check:

```bash
npm test
node demo-causal-autolearn.js
```

Focused causal check:

```bash
node --test graph.causal.test.js causalSimulator.test.js finalizer.causal.test.js demo-causal-autolearn.test.js
```

Server smoke:

```text
GET /
GET /health
GET /v2-status
GET /graph-data
```

## Current Release Contract

Release:

```text
v0.8.0
```

Expected test status:

```text
486/486
```

Expected status endpoint:

```text
version=0.8.0
testStatus=486/486
```

## v0.8 Direction Note

Trust Kernel plus ATP/AVP is the documented source-of-truth direction for v0.8.

That direction is intentionally documented before runtime work so protocol design is not mixed with incomplete storage or kernel behavior in the same step.

