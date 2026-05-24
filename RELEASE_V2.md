# AXIOM v2 Release Summary

## What is shipped

- Core `Kernel` contract now returns a stable envelope for public methods.
- `paranoidMode` disables `learnFromLLM` and any external LLM-backed learning path.
- `AXIOM_ERROR` and `CONTRACT_VERSION` are exposed for programmatic consumers.
- CLI and legacy REST behavior remain user-facing compatible.
- Minimal stdio MCP adapter is available with `tools/list` and `tools/call`.
- Deterministic benchmark fixtures are available for repeatable local performance checks.
- Benchmark regression gate is active in CI with fixture-aware checks.

## Current verification

- Test suite: `161/161`
- Benchmark runner: `npm run bench`
- Main branch: pushed and synchronized

## Current phase status

- Phase 1 (Core Contract): Completed
- Phase 2 (MCP Polish): Completed
- Phase 3 (Benchmark Regression): Completed
- Phase 4 (Packaging/Docs): Completed

## Performance snapshot

Quick benchmark output is intentionally deterministic in fixture shape and safe to compare across commits. Use:

```bash
npm run bench -- --quick
```

## Next phase priorities

1. v2.1 scope lock: inference depth and contradiction rules in `KernelV2`.
2. Expand evidence quality for multi-hop reasoning.
3. Optional Rust-vs-JS production threshold decision with real workload data.

## Non-goals for v2 Phase 1

- Dashboard
- Full NLP model integration
- New storage backend migration
- Heavy product UI work
- N-API rewrite
