# Ownership Map — #2446 (published Map phase; no code moved)

**Parent:** #2115. Child epic, does not replace it, does not narrow scope.
**Status:** plan. No code, runtime, package version or release change with this document.
**Measured:** `origin/main` @ `00cb5c37` on 2026-09-27.
Issue baseline was `main` @ `0a781c4`: 48 cross-module private calls across 18 files.
Current: `node scripts/check-module-boundary.js` → OK, 0 recorded in 0 files, none added.
`node scripts/architecture-snapshot.js` → 1096 source files, decomposition owed 1, recorded debt 15, signal 4, tracked 20.

## Entry conditions (must ALL hold before first line moves)

- [x] #2117 closed (canonical KernelV1 → KernelV2 contract). Verified Closed on GitHub 2026-09-27.
- [x] Cross-module private call count at/near zero. Verified 2026-09-27 on `origin/main` @ `00cb5c37`: OK, 0 recorded in 0 files, baseline `{"threshold":0,"files":{}}`. Snapshot: 1096 source files, owed 1, debt 15, signal 4, tracked 20.
- [x] Storage-portability scope note exists (#2115 Phase 2, Memory owns that port). Published with this PR: `docs/architecture/storage-portability-scope.md`.
- [x] Ownership map produced from source/caller evidence with disagreements recorded. THIS DOCUMENT (published with #2994, gate-enforced with the Enforce PR: `scripts/context-ownership.json` + context-aware `check-module-boundary`).

Conclusion: Map, Publish and Enforce complete. Enforce keeps the existing strictness (every cross-module private call fails) and adds the map's voice: failures name the caller's context, callers with no recorded context fail with an assignment instruction, and the map file fails closed on unknown contexts. Move: the map proves no module misplaced (only resists), so no moves.
<<<<<<< HEAD
=======

The gate also checks imports between modules whose owners are mapped. Trust may import the published `lib/verdict/action-verdict.js` contract. The two direct `graph.js` → Trust receipt imports remain dated legacy edges through 2026-12-31; the gate rejects a new cross-owner import and rejects stale or expired exceptions. Modules without a source-backed owner are still unexamined by this import rule. This is a ratchet over the mapped subset, not the epic's exhaustive ownership acceptance.
>>>>>>> origin/main

## Candidate ownership (source + caller evidence, not dir names)

| Module | Candidate | Source evidence | Caller evidence | Touches |
|---|---|---|---|---|
| `kernel.js` (855L) | UNASSIGNED — orchestrator, resists | `module.exports=Kernel` + `createAdmissionBypassOpts`, composes Graph/MemoryStore/VerifyService, `buildCanonicalReceiptPayload` | `kernel.v2.js:1`, `lib/kernel-factory.js:22-23`, `index.js:29-30` | MemoryStore (memory.db/json), graph.load/persist, sqlite handles by delegation |
| `kernel.v2.js` (497L) | AgentAction (thin canonical runtime) | `class KernelV2` wraps Kernel, adds pre-ingest/verify/contradiction/evidence | `lib/kernel-factory.js:23`, `index.js:30` | Same as Kernel by delegation, no new tables |
| `graph.js` | Knowledge | `class Graph`, Node/Edge/Claim/Hypothesis + traversal, persistence behind `lib/graph-store-port.js` (`createGraphStorePort`) | `kernel.js`, `causalSimulator.js`, `lib/rust-graph-fallback-factory.js` | SQLite graph schema + JSON journal + audit events + injected `appendReceiptToChain` |
| `rustGraph.js` (399L) | Knowledge backend surface via port (Rule 5: DECIDED — owned through `lib/graph-store-port.js`-class port, recorded here) | `class RustGraph + resolveRustBin`, child-process transport to `huqan-core`, 10s timeout | `kernel.js` optional try/catch, `lib/reason-sandbox.js`, `benchmarks/rust-vs-js-graph.js` | No durable state; `memoryPath` string + in-flight `_pending` map |
| `server.js` (201L) | UNASSIGNED — transport/composition root, resists | HTTP wiring only, `createKernel`, `createServerRouteRuntime`, `createObservabilityServerRuntime` | `server.test.js:134` only prod entry | None directly; closes observability/kernel.graph on shutdown |
| `lib/receipt/` (26 files) | Trust | `buildCanonicalReceiptPayload/hashCanonicalReceiptPayload`, `append/validateReceiptChain` | `kernel.js:27`, `graph.js:9-10`, `lib/trust-evidence-ledger.js:13,17` | No DB handle; hashes `previousReceiptHash` on passed objects |
| `lib/storage/` (4 files) | AgentAction (leases/checkpoints for agent loop), NOT Memory | DDL `checkpoints, goal_memory`, approval lease methods | root `storage.js:6`, `lib/cli-doctor.js:142` | Owns HuqanStorage SQLite schema, opened by root `storage.js` |
| `lib/memory-mutation-gate/` (7 files) | AgentAction | Pure gate `normalizer→classifier→decision`, `DECISIONS/REASONS/POLICY_VERSION` | `lib/mcp-gate-adapter.js:9`, `lib/external-action-guard.js:11` | None (no I/O) |
| `lib/verdict/action-verdict.js` | AgentAction | Pure mapping `admission/mcp → CANONICAL_VERDICTS` | `kernel.js:28`, `lib/receipt/canonical-receipt.js:18`, `lib/browser-hook-outcome.js:10` | None |
| `lib/experience/` (21 files) | Trust (durable record) + Observability (read-model) SPLIT REQUIRED — resists single owner | `contract.js` pure lifecycle; `journal.js` durable append `experience_journal` + SHA-256 fail-closed | `agentRuntime.js:5` prod wiring, `lib/http/experience-read-route.js` | `experience_journal` SQLite when store injected, else memory |
| `lib/observability/` (33 files) | Observability | `createObservabilityService({db})`, best-effort telemetry, `server-runtime.js` HTTP wiring | `lib/http/server-ingest-workflow-runtime.js:18`; `server.js` sole caller of server-runtime | Own observability DB (events/runs/alerts/jobs) via injected `db` |
| `lib/causal/` | Knowledge | causal chain simulation (per `causalSimulator.js` → `graph.js`) | `graph.js` traversal callers | Graph traversal state only |
| `lib/memory-store.js` + `lib/storage/schema.js` boundary | Memory owns MemoryRecord/Supersede; `lib/storage/schema.js` checkpoints are AgentAction leases (see above) | — | — | — |

Full 540-file `lib/*.js` inventory omitted by budget; every row above is from reading exports/functions + 2-3 callers, per #2446 Rule 6.

## Resists assignment (must not be force-fit)

- `kernel.js`: spans Knowledge (forwardChain/backwardChain/findPath), Trust (provenance-ingest, receipt projection), Memory (MemoryStore), AgentAction (admission bypass). Exactly-one requires split, not relabel.
- `graph.js`: Knowledge core but requires `receipt-chain, v4-receipt-family, audit-query` inside mutation path — violates Trust inverse.
- `server.js`: transport + composes all contexts; any single label lies.
- `lib/experience/journal.js`: durability overlaps Memory supersede/temporal AND Trust receipts; header asserts boundary vs `lib/observability/` best-effort, not enforced.
- `lib/storage/schema.js` checkpoints/goal_memory look like Memory temporal state but serve agent loop-budget/checkpointing.

## Disagreements (recorded, not settled)

1. Two Trust writers: `lib/receipt/canonical-receipt.js:13` defers verdict to `lib/verdict/` (clean seam) BUT `lib/trust-evidence-ledger.js` also builds/hashes receipts. One ownership slot, two writers.
2. `graph.js:9-10` takes `appendReceiptToChain/assertDurableV4WriteAllowed` as injected `mutationReceiptDeps` (intended Knowledge→Trust seam) but still a direct require. `kernel.js:39-44` comment admits Core→Application violation pattern.
3. `rustGraph.js` Rule 5 DECIDED since main gained `lib/graph-store-port.js` (`createGraphStorePort`, persistence behind one explicit port): Knowledge backend surface owned through a port, recorded in the table above. Remaining question (not a disagreement): whether `rustGraph.js` itself gets the same port treatment in a follow-up.

## Conflict check (do not duplicate / do not silently reassign)

- #2372 + #2373 (eight record surfaces): Trust/Observability split must align, not create a ninth parallel surface. `lib/experience/journal.js` vs `lib/observability/` vs Trust receipts is the hot spot — see disagreement 1.
- #2401 + #2402 (review queue decides scope): modules under review there are not reassigned here.
- #2115 port scope: if a port excludes something, this map does not quietly include it. Storage-portability note published alongside (`storage-portability-scope.md`) — Memory port scope known.

## Rules restated (binding for next steps)

1. Every context owns its ports + adapters. 2. Contexts talk only via public contracts. 3. Cross-context private call forbidden (`check:module-boundary` enforces). 4. One file = exactly one context. 5. `rustGraph.js` decided in writing. 6. Ownership recorded with evidence; disagreement = written question. 7. No reaching into another context's storage/transaction/memory.

## Next (blocked until entry conditions close)

1. Close storage-portability scope note (#2115 Phase 2).
2. Re-verify 0 private calls on `main`, then Publish this map as canonical doc.
3. Extend `check-module-boundary` to context-aware gate (Enforce).
4. Move only what map proves misplaced, under #2115 procedure: characterise, move-not-rewrite, mutation check, all gates green, full `npm test` with counts, one concern per PR.
