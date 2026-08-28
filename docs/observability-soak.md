# Observability bounded soak gate

The bounded soak exercises the production observability service against a temporary SQLite database using the production WAL and `synchronous=NORMAL` pragmas. It runs repeated event-write cycles, keeps one subscriber cohort connected for the entire run, reconnects another cohort every cycle, and grows the agent queue without draining it.

Run it with deterministic garbage collection enabled:

```sh
npm run bench:observability:soak
```

The JSON report includes event-write p95 latency, CPU time and CPU/wall ratio, heap growth, SQLite footprint and bytes per published event, queue depth and lag, exact subscriber deliveries, reconnect cycles, peak subscribers, and the final subscriber count. The command fails closed with `OBSERVABILITY_SOAK_TARGET_FAILED` when a target is exceeded, a delivery is lost, queue growth is not exact, or subscribers remain registered.

Targets live in `benchmarks/fixtures/observability-soak-targets.json`. They are intentionally bounded CI safety limits rather than hardware-tuning claims. The Benchmark workflow uploads the full report as an artifact for each applicable run.
