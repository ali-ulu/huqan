# AXIOM v2.0.0

AXIOM v2.0.0 is the first release where the reasoning core, integration surface, and performance baseline all line up as a usable local symbolic AI engine.

## Highlights

- Stable public `Kernel` contract across `learn`, `ask`, `verify`, `reason`, `compare`, and `dream`.
- `paranoidMode` to block external LLM-backed learning paths.
- Programmatic error catalog via `AXIOM_ERROR`.
- Explicit `contractVersion` in response metadata.
- Minimal MCP stdio adapter with discoverable tools.
- Deterministic benchmark fixtures for repeatable local performance checks.

## Benchmark summary

These benchmark numbers are from deterministic local fixtures, not live user traffic.

- `small`: `learn ~50.6ms`, `ask ~0.42ms`, `verify ~0.25ms`, `reason ~0.40ms`, `compare ~0.45ms`, `dream ~1.82ms`
- `medium`: `learn ~44.3ms`, `ask ~0.09ms`, `verify ~0.06ms`, `reason ~0.26ms`, `compare ~0.09ms`, `dream ~1.68ms`
- `large`: `learn ~43.4ms`, `ask ~0.07ms`, `verify ~0.03ms`, `reason ~0.10ms`, `compare ~0.07ms`, `dream ~5.60ms`

## Interpretation

- JS is already comfortably fast for `ask`, `verify`, `reason`, and `compare` in the current local symbolic core.
- `learn` is the dominant cost, but the current numbers are still practical for local-first usage.
- `dream` stays small enough for this graph size and only begins to expand as the graph grows.
- Rust is not yet a hard requirement for v2.0.0; it is still an optional acceleration path if graphs or throughput grow further.

## Release notes

- This release is best described as a stable reasoning core, not a full product UI release.
- The next practical steps are benchmark regression tracking, MCP polish, and public release packaging.
