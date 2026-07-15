# AXIOM v2 Release Summary

## What is shipped

- Core `Kernel` contract now returns a stable envelope for public methods.
- `paranoidMode` disables `learnFromLLM` and any external LLM-backed learning path.
- `AXIOM_ERROR` and `CONTRACT_VERSION` are exposed for programmatic consumers.
- CLI and legacy REST behavior remain user-facing compatible.
- Minimal stdio MCP adapter is available with `tools/list` and `tools/call`.
- Deterministic benchmark fixtures are available for repeatable local performance checks.
- Benchmark regression gate is active in CI with fixture-aware checks.
- Request guards now cover input sanitization, rate limiting, and optional API-key protection on write endpoints.

## Current verification

- Test suite: `215/215`
- Benchmark runner: `npm run bench`
- Main branch: pushed and synchronized

## Current phase status

- Phase 1 (Core Contract): Completed
- Phase 2 (MCP Polish): Completed
- Phase 3 (Benchmark Regression): Completed
- Phase 4 (Packaging/Docs): Completed
- Phase 5 (Manipulation Guard): Completed
- Phase 6 (Status Dashboard Polish): Completed
## Phase 7 (Evidence Polish): Completed
- Added compact verify explanation and evidence summary fields.
- Exposed clearer reasoning traces through MCP and the v2 status surface.
- Kept legacy CLI/REST output stable while improving structured v2 readability.

Phase 7 adds compact verify explanation and evidence summary fields to make structured results easier to read.

## Performance snapshot

Quick benchmark output is intentionally deterministic in fixture shape and safe to compare across commits. Use:

```bash
npm run bench -- --quick
```

## Next phase priorities

1. Finish the stronger v3 agent loop and workflow layer.
2. Harden security and request handling for public-facing usage.
3. Add operational packaging such as Docker, CI, and backup/restore.
4. Expand evidence quality for multi-hop reasoning and real workloads.

## Non-goals for v2 Phase 1

- Dashboard
- Full NLP model integration
- New storage backend migration
- Heavy product UI work
- N-API rewrite

