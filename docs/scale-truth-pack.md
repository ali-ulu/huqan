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
- Graph uses SQLite as an optional persistence backend; its primary query path
  still uses hydrated in-memory nodes, edges, candidates and audit records.
- In SQLite mode, MemoryStore now reads from SQLite, validates rows in bounded
  chunks at open, and retains a bounded 2048-entry LRU instead of a full copy
  (#3208). Its non-SQLite backend retains in-memory operational state.
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
- Graph scale is bounded by its local process, hydrated heap, and fixture
  behavior. MemoryStore's bounded retained cache does not remove its linear
  startup validation cost, synchronous read cost, or SQLite writer contention.

## 2 Ekim 2026 MemoryStore ölçümü

GÖZLENDİ: `8d92b75c3f17a4c74c511c7d83ec7557542c7b52`, Windows x64,
Node22.22.0, native SQLite3.53.1 üzerinde mevcut
`node --expose-gc benchmarks/bench-memory-store-open.js` exit0 ile çalıştı.
10k/50k/100k kayıt açılışı sırasıyla 320.7/3800.5/7140.9 ms; 20 çağrının
ortalama warm rule-list okuması 1.58/10.25/16.13 ms. Bir kayıt başına bir event
ve her 100 kayıtta bir rule kullanıldı; ölçüm tek koşudur, p95/p99 değildir.
Cache dışındaki retained heap farkı 0.1/0/-0.3 MiB; negatif değer GC/gürültüdür,
RSS veya sıfır bellek maliyeti iddiası değildir.

DOĞRULANMADI: yoğun eşzamanlı yazma, Graph100k, gerçek admission throughput,
çok süreçli cache freshness veya sunucu ölçeği. Kapasite ve backend kararının
kabul sözleşmesi [mühendislik görev paketinde](task-packs/engineering-foundation-20261002.md)
bulunur; bu ölçüm desteklenen production limit ilan etmez.

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

## Capacity limits: multi-process SQLite write contention (#3314)

The row above measures one process. This section measures what the runtime
actually ships: several long-lived processes (agent MCP servers, the HTTP
server, the CLI) writing the **same** graph/memory database file. SQLite allows
one writer per file, so the question is how much throughput is lost and whether
a write fails with `SQLITE_BUSY` after the configured retries.

Benchmark: `benchmarks/bench-sqlite-write-contention.js`. The parent seeds each
target file, then forks N child processes (`spawn`) that write into that one
file at the same time, each inside its own process and its own SQLite handle.
Every child opens its handle, waits on a barrier, then runs the timed write
loop, so all writers are connected before the first write lands. The contended
write phase is compared against a **fresh single-process run of the same total
write count**, so the reported slowdown compares like with like instead of a
small contended run against a large solo run.

`--children=N` runs a single size; the default sizes are `1, 2, 4, 8`. Graph
draws are `addNode`/`addEdge`; memory draws are `MemoryStore.store`. Because
`better-sqlite3` is synchronous, one iteration's wall time is also the longest
its process's event loop was blocked. The report keeps each process's own
maximum block, not only the merged one, so the process that blocked longest is
identifiable.

Environment: commit `cfb22b9` (benchmark `1.1.0`), Node v24.21.0, linux x64,
AMD EPYC 9B14 (4 vCPU). `--writes=30` (30 writes per child). Absolute timings
are advisory and noisy on a shared 4 vCPU host; the shapes (no failure, roughly
flat throughput, growing per-process block) are what matters.

Graph writes:

| N (processes) | total writes | wall ms | writes/s | p50 ms | p95 ms | p99 ms | max event-loop block ms | slowdown vs solo | `SQLITE_BUSY` failures |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 30  | 763.3  | 161.0 | 6.0 | 7.4  | 10.7  | 10.7  | 1.00 | 0 |
| 2 | 60  | 947.4  | 167.2 | 5.8 | 6.9  | 190.4 | 190.4 | 1.04 | 0 |
| 4 | 120 | 1338.3 | 165.2 | 5.7 | 7.9  | 516.5 | 536.0 | 1.16 | 0 |
| 8 | 240 | 2092.0 | 173.8 | 5.6 | 20.1 | 836.4 | 1217.4 | 1.08 | 0 |

Memory writes:

| N (processes) | total writes | wall ms | writes/s | p50 ms | p95 ms | p99 ms | max event-loop block ms | slowdown vs solo | `SQLITE_BUSY` failures |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 30  | 610.8 | 593.5 | 1.5 | 1.9 | 6.4   | 6.4   | 0.98 | 0 |
| 2 | 60  | 673.2 | 558.3 | 1.5 | 2.6 | 57.2  | 57.2  | 1.10 | 0 |
| 4 | 120 | 814.5 | 538.5 | 1.5 | 2.5 | 82.8  | 184.1 | 1.20 | 0 |
| 8 | 240 | 1022.0| 717.7 | 1.4 | 6.1 | 182.7 | 233.0 | 0.95 | 0 |

Checkpoint under contention (`graph-checkpoint`; 8 writers plus one process
taking repeated full checkpoints):

| writers | checkpoint cycles | checkpoint ms | p95 write ms | max event-loop block ms | `SQLITE_BUSY` failures |
|---|---|---|---|---|---|
| 8 | 4 | 9.4 | 9.4 | 1273.5 | 0 |

Reading (subject to the small write budget and the 4 vCPU host):

- **Throughput does not scale with N.** writes/s stays roughly flat from N=1
  onward for both targets (graph ~161 to ~174, memory ~594 to ~718 with noise):
  the single-writer lock serialises writes, so extra processes add no write
  throughput. The individual write (`p50`) stays flat too.
- **The cost is a per-process stall, not throughput loss.** Each process's own
  maximum event-loop block grows sharply with N (graph 10.7 to 1217.4 ms,
  memory 6.4 to 233.0 ms) while `p50` barely moves. On a synchronous driver a
  process that loses the lock waits for the whole hold, so a client sharing the
  file can be blocked for over a second at N=8. That is the figure that matters
  for an agent client, not aggregate throughput.
- **No `SQLITE_BUSY` failure survived the configured retries at any N.** The
  lock is absorbed by waiting, not by failing. Non-busy write errors are counted
  separately (`otherFailures`), and were 0 as well.
- **A full checkpoint under contention did not fail either** (0 `SQLITE_BUSY`),
  but its write phase still shows the same long per-process blocks
  (max 1273.5 ms), consistent with checkpoint and writes serialising on the
  same lock.
- The graph per-write baseline is about 3x the memory one (two node upserts plus
  an edge row per draw), which is why the same N blocks the graph loop longer.

### Migration condition (threshold, not a decision)

The measurements do **not** justify a storage change now. Treat this as the
condition to revisit, with the numbers to be re-measured at real agent counts:

> Revisit moving graph writes behind a single-writer process (or another store)
> **only if**, at the expected agent count M, a re-run of this benchmark shows a
> per-process **event-loop block above 50 ms** or any `SQLITE_BUSY` failure
> after retries.

The 50 ms figure is chosen in terms of the metric the benchmark actually
reports: the per-process maximum block (and p99), because that is what a client
sharing the file experiences. It is **not** SQLite lock wait in isolation; the
timer spans the whole synchronous write call, which is the honest bound on how
long the process was unavailable. At M = 8 the measured memory block already
exceeds 50 ms, while the graph block is far above it, so under this budget the
condition is already met for a client that cannot tolerate a second of stall.
That is a real signal, not a marginal one: re-run at the intended agent count
and write budget before acting on it. Cheaper options come first if it holds: a
single writer process with the others as clients, shorter checkpoint holds, or a
smaller `busy_timeout`. A different database is last.

`NOT_MEASURED`: agent counts above 8, writes-per-agent above 30, checkpoint
contention with a write budget large enough to force a real checkpoint hold
(here the checkpoint was fast enough that it rarely overlapped a full hold), and
any host other than the 4 vCPU machine above. Nothing here is extrapolated
beyond the table.
## Benchmark commands

```bash
node benchmarks/bench.js --quick
node benchmarks/bench.js --fixtures=small,medium,large,xlarge
node benchmarks/bench-label-lookup.js --quick
node benchmarks/bench-label-lookup.js --fixtures=n-1000,n-10000
node benchmarks/bench-scale-10k.js --quick
node benchmarks/bench-scale-10k.js --fixtures=scale-100k --iterations=1
node benchmarks/bench-sqlite-write-contention.js --writes=30
node benchmarks/bench-sqlite-write-contention.js --children=8 --writes=100
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
