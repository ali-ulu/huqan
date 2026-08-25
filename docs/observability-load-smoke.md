# Observability Load Smoke

**Status:** Implemented as a deterministic local SQLite load-smoke gate.

`benchmarks/observability-load-smoke.js` exercises the public observability service without adding a global runtime fixture. It measures event writes, event listing, summary calculation, synchronous subscriber fan-out, and queue claim/finish operations. The script emits a versioned JSON report and exits non-zero when any threshold is exceeded.

## Workload and thresholds

| Surface or resource | Workload | Blocking target |
| --- | ---: | ---: |
| Event write | 500 writes | p95 ≤ 25 ms |
| Event list | 100 reads over the seeded event set | p95 ≤ 25 ms |
| Summary | 50 reads over the seeded run/event set | p95 ≤ 25 ms |
| SSE-style fan-out | 200 publishes to 32 subscribers | p95 ≤ 25 ms |
| Queue claim/finish | 100 sequential jobs | p95 ≤ 25 ms |
| SQLite database file | 500 seeded events plus queue and fan-out workload | ≤ 5,000,000 bytes |
| Queue lag | 100 queued jobs before claim | ≤ 1,000 ms |

The fixture also requires exactly `200 × 32 = 6,400` subscriber deliveries during the fan-out window. The threshold fixture is stored in `benchmarks/fixtures/observability-load-targets.json`; the JSON report includes the Node runtime, platform, architecture, workload counts, p95/average/max timings, and resource measurements.

## Running and CI evidence

Run the smoke locally with `npm run bench:observability:load`. The Benchmark workflow runs the entrypoint directly so the uploaded `observability-load-current.json` artifact remains valid JSON rather than containing an npm lifecycle banner. The job summary includes the report and the artifact is retained with the workflow run.

This is a deterministic local-first load smoke, not a hosted staging soak test. It does not claim production p95/SLA, multi-process subscriber behavior, external deployment capacity, long-duration memory stability, or a substitute for the remaining P2.2 load/soak work.
