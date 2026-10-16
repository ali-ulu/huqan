# Production Gate B Closeout

Issue: #2125  
Scope: production resilience evidence that is reproducible in normal CI

## Verdict

`GATE_B_CLOSEOUT: PASS`

This closeout is intentionally bounded. It does not claim a 24-hour production
run, universal exactly-once behavior across every store, or that every internal
`throw new Error` carries operator metadata. It records the production-boundary
evidence required by #2125 after the issue was corrected to remove the
non-runnable 24-hour merge gate.

## Evidence

### Malformed input and fuzz

PR #3119, merged as `f2af24e47ef14d1fb5efd669686b0c512c63a478`.

The ingest property fuzz found a real boundary crash: a value with no usable
string coercion escaped `sanitizeString()`. The fix makes boundary coercion
fail closed to a safe empty value and pins the non-coercible regression.
Advanced Testing then passed ingest fuzz, MCP fuzz, fault injection and recovery
coverage on the exact PR head.

### Resource leak bounded soak

PR #3122, merged as `d6e4629a6aeef8bed3c3076a3e17f19f3606f4df`.

Benchmark Regression run:
`36474788045`

Artifact:
`observability-soak-36474788045-attempt-1`, artifact id `10992684397`.

Measured workload:

- 20 cycles
- 2,000 event writes
- 200 queue jobs
- 17,600 / 17,600 long-lived subscriber deliveries
- 8,800 / 8,800 reconnect deliveries

Measured resource evidence:

- heap slope after warmup: 3,100.88 bytes/cycle
- RSS slope after warmup: 165,573.09 bytes/cycle
- heap growth: 256,336 bytes
- open file descriptors: 23 baseline, 26 with SQLite open, 23 after cleanup
- active-resource delta after cleanup: 0
- active-handle delta after cleanup: 0
- timer delta after cleanup: 0
- child-process delta after cleanup: 0
- subscriber count after cleanup: 0
- SQLite connection open before cleanup and closed after cleanup

The merged gate now enforces bounded heap/RSS slope and zero cleanup deltas for
file descriptors, active resources, active handles, timers and child processes.

### Durable-write recovery inventory

PR #3124, merged as `3a088ea9d98e919406b50275727bad1aeb1c7661`.

`lib/http/crash-recovery-inventory.js` is the executable owner inventory.
`test/gateA-crash-recovery.test.js` requires the current durable owner set and
fails if any row lacks a mechanism, recovery proof or coverage status.

The required owner set includes Graph JSON/SQLite, memory-store SQLite,
agent-run finalization, external-client replay, A2A replay/task and delegation
audit, MCP capability nonces, registry records, agent memory, command policy,
hypothesis thresholds, emergency stop, streaming trust, GitHub App beta store,
backup create/restore, external-action receipt state and observability jobs.

At closeout, `getUncovered()` is required to be empty.

### Production HTTP error taxonomy

PR #3123, merged as `1d2ad3b3b43324095288432c3e8940f3c8f00e3c`.

The production HTTP boundary now adds stable machine-readable error
classification and operator action while preserving legacy error strings where
compatibility requires them. The shared taxonomy covers input,
authentication, authorization, routing, method, state conflict, request limit,
rate limit, availability and internal failure classes.

Benchmark Regression run `36479167303` and the associated required workflows
completed successfully on the PR head before merge.

This does not mechanically rewrite every internal exception. The contract is at
the production-facing HTTP failure boundary.

### Observability

Correlation proof first landed in PR #3120, merged as
`4c4dec5588f058dec4dccff741f0bf102989b716`.

Gate B closeout proof landed in PR #3125, merged as
`417efe919e68271b4e4b5e0ae69128dc931a3849`.

`test/gate-b-observability-closeout.test.js` executes the three required
behaviors:

1. the real HTTP request handler generates a server-owned `X-Request-Id` and
   the same identity reaches the structured error log;
2. observability health remains live while readiness returns 503 for dependency
   failure; and
3. a real nightly shard failure sidecar produces an issue-create action, while
   the workflow wires that path only to failed scheduled runs with
   `issues: write`.

PR #3125 passed Advanced Testing, Benchmark Regression, Security Checks,
CodeQL, External Conformance, Architecture Checks, API Contract, Workflow
Governance, Workflow BDD Contract, Rust Accelerator, Mutation Testing and the
installed-package smoke before merge.

## 24-hour soak

No 24-hour soak is claimed.

A 24-hour self-hosted run remains optional operational evidence. It is not a
merge gate and is not required for Gate B closeout. The reproducible CI contract
is the bounded continuous resource soak described above.

## Closeout boundary

Gate B is closed for the evidence explicitly listed here:

- malformed boundary fuzz is fail-closed;
- the bounded soak publishes and enforces process-resource cleanup evidence;
- the durable-write recovery inventory has no uncovered required owner;
- production-facing HTTP failures carry stable code/class/operator guidance;
- correlation, liveness/readiness separation and the nightly alert path have
  executable proof.

Future production surfaces must satisfy the same gates when they introduce a
new durable store, outward failure boundary, long-lived resource or
observability path.
