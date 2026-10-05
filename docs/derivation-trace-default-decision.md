# Derivation trace: default-on and dedup decision

Issue: #3496 (R41). Radar sources: #3267 (apache/jena derivation logging),
#3266 (OpenSPG/KAG TraceLog).

This is the cost + scope decision the issue asks for. It is bounded to the
**inference runtime's derivation record** (`lib/inference-runtime-records.js` →
`lib/inference-derived-record.js`), which is the graph surface that already
records a verifiable step. It does not add a new recording surface.

Evidence: `benchmarks/bench-derivation-record.js`, raw output in
`docs/reports/derivation-trace-20261005.json`. All numbers below were produced
on `main` at `cd9c53e5`, Node 22, with `--sizes=100,400,1000`.

## What already exists

The runtime already records a derivation **by default**. In
`lib/cli-inference-runtime.js`, the `evaluate` action always runs
`buildRecords(...)` and commits the result; there is no `record: false` switch.
The record is provenance-preserving and holds no hidden reasoning: it carries
`fact`, `ruleId`, `bindings`, `directSupports`/`supports`, the graph/rule
snapshot ids and a history event. What it does **not** yet have is a written
default/dedup decision. That is the gap this note closes.

Identity: `derivationId = prov_<sha256(workspaceId + fact + ruleId + bindings +
supports + snapshot)>`. It is deterministic and includes the snapshot ids.

## Measured cost of keeping the trace

Marginal to evaluation, because the candidate is derived whether or not a trace
is kept. The record is the extra work:

| derived records | buildMs | bytes/record | total bytes | record/evaluation |
| --- | --- | --- | --- | --- |
| 200 | 5.4 | 1823 | 0.36 MB | 0.19 |
| 800 | 15.6 | 1829 | 1.46 MB | 0.17 |
| 2000 | 29.4 | 1831 | 3.66 MB | 0.06 |

- **Time**: ~0.015 ms per record; the record/evaluation ratio falls as the
  graph grows (0.19 → 0.06), so recording never dominates the derivation it
  describes.
- **Space**: ~1.8 KB per record, stable across sizes. 2000 derived facts cost
  ~3.7 MB. This is the number a retention/compaction bound must be sized
  against, not a reason to make recording opt-in.

## Dedup: correct within a run, absent across runs

Two different things are both called "dedup" here, and they have different
answers:

1. **Within one run — correct, default-on.** A fact derivable by two rules is
   emitted once (`duplicateSuppressed >= 1`; the cross-rule probe yields 1
   candidate from 2 rules), and every emitted record has a distinct
   `derivationId` (`uniqueIds == records`, `duplicateIds == 0`). Re-deriving the
   same run against the same snapshot reproduces the same ids
   (`rerunStable == true`), so a re-issued run collides instead of duplicating.
2. **Across runs — absent, by construction.** `derivationId` embeds the graph
   snapshot id, so when the graph grows the *same logical derivation* gets a
   **new** id. The runtime's merge loop
   (`previous = Map(records by derivationId)`) therefore cannot recognise it.
   Measured growth for a graph that adds one fact per step:

   | snapshot | facts | accumulated records |
   | --- | --- | --- |
   | 2 | 2 | 3 |
   | 4 | 4 | 10 |
   | 8 | 8 | 36 |

   Eight distinct derivations become 36 records — O(K²) for K growth steps.

## Decision

1. **Keep recording default-on.** The cost is marginal and already the
   behaviour; making it opt-in would hide the verifiable step for a saving that
   the measurements do not justify.
2. **Keep provenance, reject hidden reasoning.** The recorded step is the
   `ruleId + supports + conclusion` triple, not a narration. A record whose
   supports cannot be re-checked is out of scope.
3. **Keep snapshot-scoped identity; do not silently collapse it.** A
   derivation is only reproducible *relative to a snapshot*, so folding two
   snapshots into one id would make the record claim a reproducibility it
   cannot support. The O(K²) growth is the honest cost of that choice.
4. **Bound the growth, do not dedup it away.** The open work is a
   retention/compaction policy over accumulated records (drop or archive
   records whose snapshot is superseded), sized against the ~1.8 KB/record
   number above. That is a separate, budgeted task; this decision only records
   that cross-snapshot dedup is **not** the fix, because it would erase the
   snapshot a derivation was valid for.

## What this does not claim

- It does not measure the `coder` derivation record
  (`lib/coder/derivation-record.js`), which is a different, file-content
  reproducibility artifact.
- It does not measure persistence/IO cost; `buildMs` is in-memory record
  construction only.
- It does not decide the compaction mechanism, only that compaction — not
  cross-snapshot dedup — is the bounded follow-up.
