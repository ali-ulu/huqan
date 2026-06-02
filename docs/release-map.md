# AXIOM Release Map

## Current Stable Release

```text
v0.7.0 - Causal Reasoning Layer
```

Status:

- GitHub Release published
- tag: `v0.7.0`
- target: `main`
- expected tests: `392/392`

## Release History

### v0.3 - Personal Thought Judge

Focus:

- graph reliability
- plugin contract
- evidence ranking
- personal reasoning plugins

### v0.4 - Company Brain

Focus:

- repository memory
- company context
- GitHub, markdown, manual notes, and decision ingest

### v0.5 - Agent OS + Discovery Engine

Focus:

- workflow runtime
- workflow tools
- deterministic agent execution
- discovery skeleton

### v0.6.0 - Productization & Shield

Focus:

- product UI
- AXIOM Shield
- `autoLearn=false`
- ingest helper extraction
- SDK wrappers
- deterministic finalizer
- demo smoke

### v0.7.0 - Causal Reasoning Layer

Focus:

- causal relation schema
- deterministic causal traversal
- what-if simulator
- causal finalizer summary
- `autoLearn true` safety demo

Product sentence:

```text
What breaks if you do this?
```

## Recommended v0.8 Direction

```text
v0.8 - Trust Kernel & AXIOM Trust Protocol
```

Recommended focus:
- Trust Kernel
- ATP v0.1 and AVP verify subset
- provenance binding and trust policy
- append-only audit log
- lightweight workspace scoping
- conflict routing and quarantine
- `.axiom` exchange format
- protocol-ready connector contracts

PR Roadmap:
- PR-0: Trust Kernel + ATP/AVP docs
- PR-1: provenance schema
- PR-2: trust policy config + provenance ingestion
- PR-3: audit log core
- PR-4: workspace scoping + SQLite indexes
- PR-5: conflict routing + quarantine
- PR-6: provenance-aware GitHub connector
- PR-7: provenance query API + trust dashboard
- PR-8: ATP/AVP v0.1 hardening + conformance suite
- PR-8.5: `.axiom` exchange / package format draft
- PR-9: minimal `axiom-verify` package skeleton
- PR-10: v0.8 release prep

Reasoning:
v0.6 made AXIOM usable.
v0.7 made AXIOM causal.
v0.8 should make AXIOM accountable and portable.


## v0.8 Non-goals

- new causal behavior
- broad connector suite on day one
- full enterprise governance suite
- autonomous source discovery
- probabilistic prediction layer

## Release Rule

Do not tag a final release until these pass on `main`:

```bash
npm test
node demo-causal-autolearn.js
```

Required HTTP smoke:

```text
GET /
GET /health
GET /v2-status
GET /graph-data
```
