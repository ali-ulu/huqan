# Changelog

## v0.10.0

Unreleased. The first version prepared for the npm registry: `huqan` has never
been published, so every install to date has been a `git clone`.

### Added
- `huqan-mcp` binary. `mcpServer.js` gained a shebang and a `bin` entry, so the
  MCP server can be started by name instead of by absolute path. Claude Desktop
  can now be configured with `npx -y --package=huqan huqan-mcp` and no prior
  install.
- `GET /api/v2/memory-approvals` and `POST /api/v2/memory-approvals/{id}/decision`
  — operator-gated approval over HTTP. Both require the API key *and* a separate
  operator token in `x-huqan-operator-token`, so the surface that may propose a
  memory write cannot approve it. Unconfigured, they answer 404.
- `docs/a2a-deployment.md` — the operator recipe for the four A2A routes, which
  shipped with no way to turn them on.
- English spellings for every CLI command that had only a Turkish one: `status`,
  `dream`, `save`, `think`, `stop thinking`, `consolidate`, `hello`, `agent:`,
  and bare `why X`. The Turkish spellings keep working.

### Fixed
- A `PREVENTS` edge made `verify` contradict the sentence that states it, at
  confidence 0.95. `CAUSES`, `ENABLES` and `DEPENDS_ON` were correct; only
  `PREVENTS` inverted.
- Manual and decision ingest failed on every causal relation. `addCompanyEdge`
  never passed `strength`, which `graph.js::addEdge` requires for a causal
  relation and enforces by throwing, so each attempt left orphan nodes and no
  edge. The rule now lives in `lib/causal-edge-strength.js`.
- `huqan.policy` reported HUQAN's own advertised tools as unknown third-party
  tools: `huqan.learn` answered `external / block` while `learn` answered
  `internal / allow`. Namespaced names now resolve, and MCP tool names are
  answered from `lib/mcp-gate-adapter.js`, the authority for what calling one
  does.
- Turkish prose on English API surfaces: the evidence sentences built in
  `lib/verify.js` and the MCP tool descriptions. Three of those literals also
  carried `U+FFFD`, so callers were reading `Say?sal kar??la?t?rma`.
- `docs/current-agent-checkpoint.json` pinned a `canonicalMain` SHA that is not
  a reachable object in this repository, which failed
  `scripts/agent-context.js` and four tests.

### Changed
- **MCP `huqan.verify` emits the canonical English status vocabulary**
  (`verified` / `contradicted` / `unknown`) instead of the Turkish one. This is
  a wire change on an advertised output schema, gated in RFC-001's M1-M4 shape:
  `HUQAN_MCP_LEGACY_VERIFY_STATUS=1` restores the legacy enum, and one predicate
  drives both the advertised schema and the emitted payload so they cannot
  disagree. Removal of the opt-in needs its own announced breaking release.
- The CLI command reference is English-first.
- AXIOM-era names moved to HUQAN across the surfaces that carry no wire, data or
  signed-artifact contract, each with the old name retained as an alias:
  `createAxiomClient`, `runAxiomSdkCommand`, the LangChain tool name,
  `server.closeAxiom`, `AxiomStorage`, the `axiom-core` crate, the identity
  fallback subject, and `lib/axiom-package-format.js`, whose implementation
  moved to the canonical filename.
- `/llm-sor` emits `huqanCheck` alongside `axiomCheck`, never instead of it.

### Unchanged, deliberately
The frozen ATP 0.1 lineage — `format: "axiom-package"`, `atpVersion: "0.1"`,
the fixtures under `specs/axiom-package-format/0.1/`, `packages/axiom-verify`
and the `.axiom.json` reader. They are what proves old packages still verify.
The `axiom.*` MCP aliases and `AXIOM_*` environment variables stay accepted on
input and are never emitted.

## v0.9.1

Released 2026-06-12 (Memory Core Final), following the 2026-06-07 AB1 Action Risk Classifier release.

### AB1 Action Risk Classifier (2026-06-07)

#### Added
- `lib/action-risk-classifier.js` — deterministic action risk classifier (AB1)
  - `classify(action, opts)` function — classifies intended agent actions before execution
  - 11 action types: `read_only`, `local_analysis`, `test_execution`, `file_write`, `memory_write`, `tool_execution`, `network_access`, `deployment`, `destructive`, `auto_merge`, `unknown`
  - 4 risk levels: `low`, `medium`, `high`, `critical`
  - 4 decisions: `allow`, `review`, `block`, `human_review`
  - Safe normalization: `null`, `undefined`, empty object, unknown types all handled without throwing
  - Policy version: `AB1.0.0`
- `test/action-risk-classifier.test.js` — 21 tests, 0 failures
  - 6 core tests covering all critical action types
  - 15 edge case tests covering null/undefined/malformed inputs

#### Rules (AB1)
- No agent action bypasses classification
- `auto_merge` and `destructive` are permanently blocked
- `deployment` requires explicit human review
- Unknown action types are never silently allowed

#### Not included (AB1 scope boundary)
- No tool execution
- No server/API/MCP changes
- No memory writes
- No deploy logic
- No auto-merge logic

### Memory Core Final Release (2026-06-12)

#### Added
- Memory Core compatibility aligned on `main` after PR #42.
- Main `MemoryStore` now exposes the Memory Core compatibility surface without replacing the normalized SQLite architecture.
- Release smoke now reflects the final verified full suite result: `1277 pass / 0 fail / 16 skipped`.

#### Highlights
- Main MemoryStore architecture preserved.
- Memory Core API compatibility aligned.
- SQLite and normalized persistence compatibility preserved.
- Deterministic memory behavior preserved.
- Provenance, audit, and workspace invariants preserved.
- Package schema and roundtrip coverage preserved.

#### Out of scope
- Self-Healer
- MCP tool surface expansion
- UI changes
- embeddings
- summary / cluster plugin
- runtime import/export expansion beyond the existing MemoryStore behavior

