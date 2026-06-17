# Changelog

## v0.9.1 - Memory Core Final Release

Released 2026-06-12.

### Added
- Memory Core compatibility aligned on `main` after PR #42.
- Main `MemoryStore` now exposes the Memory Core compatibility surface without replacing the normalized SQLite architecture.
- Release smoke now reflects the final verified full suite result: `1277 pass / 0 fail / 16 skipped`.

### Highlights
- Main MemoryStore architecture preserved.
- Memory Core API compatibility aligned.
- SQLite and normalized persistence compatibility preserved.
- Deterministic memory behavior preserved.
- Provenance, audit, and workspace invariants preserved.
- Package schema and roundtrip coverage preserved.

### Out of scope
- Self-Healer
- MCP tool surface expansion
- UI changes
- embeddings
- summary / cluster plugin
- runtime import/export expansion beyond the existing MemoryStore behavior

## v0.9.1 — AB1 Action Risk Classifier

Released 2026-06-07.

### Added
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

### Rules (AB1)
- No agent action bypasses classification
- `auto_merge` and `destructive` are permanently blocked
- `deployment` requires explicit human review
- Unknown action types are never silently allowed

### Not included (AB1 scope boundary)
- No tool execution
- No server/API/MCP changes
- No memory writes
- No deploy logic
- No auto-merge logic

