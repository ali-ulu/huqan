# AXIOM Memory Benchmark — Watch Items (PR-S4B)

This document is a **read-only watch guide** for the memory scale benchmark
introduced in PR-S4B. It does not run anything; it tells the next operator
what to look at and when.

## What PR-S4B added

- `benchmarks/bench-memory-scale.js` — deterministic memory benchmark
  (small=10, medium=100, large=1000) measuring `ingestMs`, `queryMs`,
  and `roundtripMs` on a fresh in-memory `MemoryStore`.
- `benchmarks/snapshot-memory.js` — produces a versioned JSON snapshot
  with `schema`, `version`, `commit`, `iterations`, `seed`, and
  per-fixture timing fields.
- `benchmarks/bench-memory-scale.test.js` and
  `benchmarks/snapshot-memory.test.js` — minimal smoke tests.

No runtime code was changed. No baseline was overwritten.

## Watch item 1 — Shape parity (always blocking)

- `recordCount` for each fixture must equal `size`.
- If a fixture's `recordCount` drops below its `size`, the in-memory
  `MemoryStore` is silently losing records. Stop and investigate before
  shipping.

## Watch item 2 — Timing trend (advisory by default)

- Compare `ingestMs` / `queryMs` / `roundtripMs` across snapshots from
  the same machine and same Node version. A 2x regression on the same
  hardware is a real signal; a 1.2x drift is probably noise.
- Use `PR-S4A`'s `check-regression.js` with `--strict-timing` if you
  need an explicit failure on drift.

## When to regenerate a snapshot

- Before and after any change that touches `lib/memory-store*`.
- Before cutting a release tag (so the snapshot can be archived with it).
- After bumping Node major versions (timing is not portable across
  V8 majors).

## How to regenerate

```bash
# Human-readable report
node benchmarks/snapshot-memory.js

# Machine-readable, to stdout
node benchmarks/snapshot-memory.js --json

# Machine-readable, to a gitignored file (recommended for CI)
node benchmarks/snapshot-memory.js --output=benchmarks/memory-snapshot.json
```

If you write to `benchmarks/memory-snapshot.json`, make sure it is listed
in `.gitignore`. This PR intentionally does not commit any snapshot.

## Out of scope for this PR

- Baseline calibration (separate PR).
- Memory store runtime changes (PR-S5 family, separate work).
- Real-scale fixtures (10k+ records) — that requires its own design
  decision and is not part of S4B.
