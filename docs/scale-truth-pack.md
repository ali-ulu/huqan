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
node benchmarks/verifBench.js
node --test benchmarks/bench.test.js benchmarks/bench-label-lookup.test.js benchmarks/check-regression.test.js
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
