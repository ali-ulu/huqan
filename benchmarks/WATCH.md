# AXIOM Memory Benchmark — Watch Items (PR-S4B)

This document is a **read-only watch guide** for the memory scale benchmark
introduced in PR-S4B. It does not run anything; it tells the next operator
what to look at and when.

## What PR-S4B added

- `benchmarks/bench-memory-scale.js` — deterministic memory benchmark
  (small=10, medium=100, large=1000) measuring `ingestMs`, `queryMs`,
  and `roundtripMs` for separate in-memory and SQLite fixture groups.
  `queryMs` times `list()` on a prebuilt store, and every metric excludes
  two fixed V8/JIT warmup calls.
- `benchmarks/snapshot-memory.js` — produces a versioned JSON snapshot
  with `schema`, `version`, `commit`, `iterations`, `warmupIterations`,
  `seed`, and per-fixture timing fields for both backend groups.
- `benchmarks/bench-memory-scale.test.js` and
  `benchmarks/snapshot-memory.test.js` — minimal smoke tests.

No runtime code was changed. No baseline was overwritten.

## Watch item 1 — Shape parity (always blocking)

- `recordCount` for each fixture must equal `size`.
- If a fixture's `recordCount` drops below its `size`, the in-memory
  `MemoryStore` is silently losing records. Stop and investigate before
  shipping.

## Watch item 2 — Timing trend (advisory by default)

- Compare `ingestMs` / `queryMs` / `roundtripMs` within the same backend
  group, across snapshots from the same machine and same Node version. A 2x
  regression on the same hardware is a real signal; a 1.2x drift is probably
  noise.
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
- Cross-backend regression thresholds — the two fixture groups are reported
  separately; this benchmark does not claim that their absolute timings are
  directly comparable.

## #3011 — graph incremental-save (added 2026-09-29)

`save()` used to rewrite every node and edge row on every call, so the cost of
a save scaled with the graph size. The delta tracking that closed #3011 writes
only the records a mutation touched, and this benchmark pins that claim.

- `benchmarks/bench-graph-save.js` — full benchmark (no `--quick`) at
  `n-1000` and `n-10000`. For each fixture it times a full checkpoint (first
  save / after `load()` / threshold) against an incremental save after one
  mutation, and counts the rows each physically wrote.
- `benchmarks/graph-save-baseline.json` — the pinned baseline. Row counts and
  the ratio floors are deterministic; the absolute milliseconds are advisory.
- `benchmarks/check-graph-save.js` — the gate. Blocking on every run:
  `incrementalRows <= 2`, `rowReduction >= 1000`. Blocking only under
  `--strict-timing`: `writeRatio >= 3` and absolute timing within `4x` of the
  baseline. `--strict-timing` is what the nightly job uses.

Watch item — the two floors mean different things. `rowReduction` is the
issue's contract and would fail on any machine if the full rewrite returned.
`writeRatio` and the absolute milliseconds are hardware-sensitive; a red
nightly run on the timing half alone means a slow runner, a red run on the
row half means a real regression.

How to run it:

```bash
# Full benchmark, human-readable
node benchmarks/bench-graph-save.js

# Machine-readable, to a gitignored file (recommended for CI)
node benchmarks/bench-graph-save.js --json > benchmarks/graph-save-current.json

# Enforce the pinned threshold
node benchmarks/check-graph-save.js benchmarks/graph-save-baseline.json benchmarks/graph-save-current.json --strict-timing
```

Regenerate the baseline only after an intentional change to the save path, and
only from a quiet machine.
