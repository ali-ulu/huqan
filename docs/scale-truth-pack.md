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

## Benchmark commands

```bash
node benchmarks/bench.js --quick
node benchmarks/bench.js --fixtures=small,medium,large,xlarge
node benchmarks/verifBench.js
node --test benchmarks/bench.test.js benchmarks/check-regression.test.js
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
