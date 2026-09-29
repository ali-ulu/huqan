# Scale Truth Pack

Current measured position for AXIOM graph and memory behavior:

- local-first
- deterministic
- small-to-medium graph tested
- larger graph support requires dedicated benchmarking
- not yet proven at Wikipedia-scale
- scale roadmap exists but is not claimed

## What is proven

- Graph and Memory Core run locally.
- Graph state is primarily in-memory.
- SQLite is used as an optional persistence backend and mirror, not as the primary query engine.
- Memory Store keeps operational state in memory with optional SQLite persistence.
- Existing benchmark fixtures cover `small`, `medium`, `large`, and `xlarge`.
- The largest existing benchmark fixture is `xlarge`, with 140 nodes and 131 edges in the current benchmark results.
- The end-to-end scale benchmark (#3016) measures `scale-10k` with 10000 nodes and 10000 edges (see below).

## What is not proven

- 100k-node production claims.
- 1M-node claims.
- Wikipedia-scale throughput or latency.
- Enterprise graph scale claims.
- Unlimited dream/random-walk depth or breadth.

## Current limits

- `graph.js` queries read from in-memory node/edge structures; SQLite persists state but does not replace the in-memory query path.
- `dream.js` is heuristic and bounded:
  - `dream()` returns at most 10 hypotheses.
  - Similarity, transitive, gap, symmetry, and contradiction generation are each capped internally.
  - `_biasedWalk()` is bounded by `walkLength` and `walksPerNode`.
- Memory scale is bounded by the same local process, heap, and fixture behavior unless a dedicated benchmark proves otherwise.

## Measured fixtures

| Fixture | Nodes | Edges |
|---|---:|---:|
| `small` | 6 | 5 |
| `medium` | 19 | 15 |
| `large` | 49 | 30 |
| `xlarge` | 140 | 131 |
| `scale-10k` (#3016) | 10000 | 10000 |

## End-to-end scale benchmark (#3016)

`benchmarks/bench-scale-10k.js` seeds a 10000-node / 10000-edge graph through
the Graph API and measures seed (write), ask, verify, reason (read) and a full
SQLite checkpoint save (write), plus heap. The pinned numbers live in
`benchmarks/scale-10k-baseline.json`; `benchmarks/check-scale-10k.js` gates
the shape as blocking and the timings as advisory (`--strict-timing` for the
nightly job).

Baseline on a developer machine (advisory, not portable across machines or
Node majors):

| Path | Measure |
|---|---:|
| seed 10k nodes+edges | ~165 ms (~60k nodes/s bulk write) |
| ask | ~2 ms |
| verify | ~54 ms |
| reason | ~4 ms |
| save (full SQLite checkpoint) | ~856 ms |
| heap delta for the 10k seed | ~19 MB |

Supported-scale statement after #3016: the graph engine, the query paths
(ask/verify/reason) and the save path are measured at 10k nodes on a single
machine. `kernel.learn` admission is explicitly NOT covered at 10k: its
per-node cost rises superlinearly (about 19 ms at n=100, 29 ms at n=200,
41 ms at n=400 on the same machine), so a 10k learn batch does not finish in
a benchmark budget. 100k remains opt-in only (`--fixtures=scale-100k`) and is
not a default or CI measurement.

## Graph label-lookup benchmark (#3009)

`benchmarks/bench-label-lookup.js` contrasts the indexed label lookup against
the pre-#3009 linear scan (`Object.values(nodes).filter(...)`) on the same node
map. Defaults are `n-1000` and `n-10000` nodes across 64 labels and 4
workspaces, with 1000 repeated probes to lift the single-query noise floor.

At `n-10000` on a developer machine the indexed query is roughly two orders of
magnitude faster than the scan (about 0.03 ms vs 3.3 ms per query, ~97x over
1000 probes); the workspace-scoped node count is O(1) versus a full scan
(~0.003 ms vs ~4.9 ms, >1500x). Exact numbers are machine-dependent; run the
command to reproduce.

## Benchmark commands

```bash
node benchmarks/bench.js --quick
node benchmarks/bench.js --fixtures=small,medium,large,xlarge
node benchmarks/bench-label-lookup.js --quick
node benchmarks/bench-label-lookup.js --fixtures=n-1000,n-10000
node benchmarks/bench-scale-10k.js --quick
node benchmarks/bench-scale-10k.js --fixtures=scale-100k --iterations=1
node benchmarks/verifBench.js
node --test benchmarks/bench.test.js benchmarks/bench-label-lookup.test.js benchmarks/bench-scale-10k.test.js benchmarks/check-regression.test.js
```

## Safe public language

Use these phrases:

- local-first
- deterministic
- small-to-medium graph tested
- larger graph support requires dedicated benchmarking
- not yet proven at Wikipedia-scale
- scale roadmap exists but is not claimed

Avoid these claims unless a future benchmark proves them:

- millions of nodes supported
- Wikipedia-scale
- enterprise graph scale
- production-scale knowledge graph

## Recommendation

Public docs and demos should describe AXIOM as a deterministic local-first reasoning engine with measured small-to-medium graph coverage, and should keep larger-scale claims as roadmap items until a dedicated benchmark pack proves them.
