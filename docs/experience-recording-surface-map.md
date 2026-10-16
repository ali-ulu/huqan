# Experience Core recording-surface map

Issue: #2373  
Source baseline: `afad3b69f3b24dc46e6c5f8465c4febb0d144727`

This is the E0-a decision record. It maps the eight recording surfaces that
already exist to Experience Core before runtime wiring. It does **not** wire
Experience into production and it does not claim that a migration has already
happened.

## Decision rule

Each existing surface gets exactly one verdict:

- **kept** — it records a different fact and remains an authority for that fact;
- **fed** — its interface remains, but overlapping lifecycle truth is projected
  from Experience once the runtime seam exists;
- **subsumed** — Experience replaces the surface.

No surface is subsumed in this map. Deleting an operational, trust, provenance,
audit, or recovery authority merely because Experience can mention the same
action would collapse distinct guarantees into one store.

Experience itself has a narrower contract:

- `lib/experience/journal.js` is durable when backed by the injected store,
  ordered per run, integrity-protected, and fail-closed on a failed append;
- the same file explicitly distinguishes those guarantees from observability,
  which is best-effort;
- `lib/module-reachability.js` records that the Experience journal still has
  no production caller. Therefore every migration direction below is a design
  commitment for the runtime-wiring work, not a description of current wiring.

## Surface map

| Existing surface | Verdict | Why this is a different fact / authority | Migration and dependency direction |
| --- | --- | --- | --- |
| `lib/audit-log.js`, `audit-query.js`, `audit-bounded-read.js` | **kept** | Audit records operator/domain actions in its own vocabulary (`LEARN`, `REJECT`, `UPDATE`, `DELETE`, `QUERY`, conflict/claim events) and carries actor, target, workspace and provenance fields. It is not limited to an Experience run and is queryable by those audit dimensions. | Existing audit rows stay unchanged. Experience may carry an `auditId`/correlation reference for an overlapping action, but an Experience event does not manufacture or replace a non-run audit event. No synthetic backfill. |
| Durable mutation journal: `lib/mutation-journal.js`, lock/recovery support and Graph journal storage | **kept** | The mutation journal is the authority for whether an `operationId` completed, replay protection, the committed result, mutation receipt and receipt-chain tip. On JSON it also documents the save/journal crash window; on SQLite state and journal can commit together. Those are execution-idempotency/recovery guarantees, not run-history guarantees. | Keep the journal and existing records. A runtime Experience event may reference `operationId`, receipt id/hash and outcome, but Experience must never be consulted instead of the journal to decide whether a mutation may replay. |
| Receipt family under `lib/receipt/` and related receipt modules | **kept** | Receipts are portable trust/evidence artifacts. Canonical receipts have deterministic hashes; public trust receipts bind to internal receipt/bundle hashes and may carry Ed25519 signatures with trusted-key verification. That is an assertion/proof artifact, not merely a historical event. | Existing receipts remain authoritative and unchanged. Experience stores references such as receipt id/hash (and bundle hash where relevant); it must not reconstruct hashes/signatures from event history. |
| Provenance: `lib/provenance-ingest.js`, `provenance-query.js` and stored provenance fields | **kept** | Provenance identifies where a claim came from: `provenanceId`, `sourceRef`, source type/subtype, actor, workspace, trust-policy version, optional content hash and source version. It is source lineage and evidentiary context, not execution history. | Preserve existing provenance records. Experience references `provenanceId` (and may copy bounded display metadata), while source identity/trust remains owned by provenance. Do not fabricate provenance while backfilling Experience. |
| `lib/gate-telemetry.js` | **kept** | Gate telemetry is deliberately **non-authoritative**: its source states that a failed metrics write must never revise, delay or downgrade an already-made gate decision. It also emits the plugin `afterGateDecision` signal and can cover gates outside an Experience run. | Keep the telemetry seam. Once runtime wiring exists, a run-scoped authoritative policy decision is recorded as Experience and the telemetry event may be correlated to the same run/decision. Telemetry failure must still have zero effect on Experience or the gate verdict. |
| `lib/observability/` | **kept** | Observability is an operational view with explicit retention: by default events/queue are retained 7 days and completed runs/alerts 30 days, then cleanup deletes them. Experience is intended to be durable, complete and fail-closed. A retention-bound dashboard store cannot be the learning-history authority. | Keep observability and its retention policy. It may consume/correlate Experience identifiers for dashboards, but Experience must never derive completeness, verification or learning eligibility from observability rows. Existing observability data is not backfilled into Experience. |
| `storage.saveRun` → `agent_runs` | **fed** | `agent_runs` currently stores run status/report/state plus iteration and `iterations_delta` accounting. The lifecycle/status portion overlaps directly with Experience, while budget/accounting fields are operational data used by the existing agent store. Leaving both as independent lifecycle authorities would create two answers to “what happened in this run?”. | Keep the table/API for compatibility and accounting. **Direction: Experience → `agent_runs` projection** once #2378 runtime wiring exists and parity is proven. Authoritative terminal lifecycle/outcome fields are projected from the closed Experience manifest; local accounting fields may remain store-owned. Existing pre-Experience rows remain legacy rows and are not converted into invented Experience histories. |
| `storage.saveGoalMemory`, checkpoints and finalization state | **kept** | Checkpoints are mutable resume state; goal memory is an operational summary used across runs. `lib/agent-run-finalization.js` intentionally commits run state, goal memory and checkpoint handling together so spent budget/resume state survives failures. An append-only Experience history cannot replace the live resume cursor. | Keep existing rows and transaction semantics. Future goal-memory updates may record the source Experience/run id, but checkpoints remain the authority for resumption and Experience remains the history. Do not rebuild a checkpoint by replaying Experience unless a separate recovery contract explicitly defines that behavior. |

## Authority boundaries

The map creates four hard boundaries for the implementation phases that follow.

1. **One run-history authority.** After production runtime wiring, Experience
   owns durable lifecycle/outcome/learning-history truth. `agent_runs` may
   expose a compatibility projection, but it may not independently disagree
   with the closed Experience manifest.
2. **Operational stores stay operational.** Observability, gate telemetry and
   checkpoints may be missing, retained, compacted or updated according to
   their own contracts without rewriting an already-recorded Experience.
3. **Trust evidence is referenced, not re-created.** Receipts and provenance
   keep their own hashes, signatures, trust-policy and source semantics.
   Experience records their identifiers/bindings when they participate in a
   run.
4. **Recovery authority is not history authority.** The mutation journal decides
   replay/idempotency/recovery. Experience records what the runtime observed; it
   does not grant permission to replay an effect.

## Existing-record migration

There is no bulk synthetic conversion of old data.

- Existing audit, mutation-journal, receipt, provenance, telemetry,
  observability, goal-memory and checkpoint records remain where they are.
- Existing `agent_runs` rows remain legacy run records. They may be read by
  compatibility code, but they are not sufficient evidence to mint a
  historical Experience after the fact.
- The cut-over point is the first production runtime version that can append a
  complete Experience fail-closed. From that point forward, overlapping
  `agent_runs` lifecycle fields are a projection of that Experience.
- A migration tool may later attach cross-references where a stable identifier
  already exists. It must not invent missing events, verification, provenance,
  approvals, receipts or learning eligibility.

## Consequences for the R3 sequence

- #2378 runtime wiring must establish the Experience append first, then update
  compatibility/operational projections without making those projections the
  Experience authority.
- #2399 crash recovery may consult the mutation journal and Experience
  reconciliation together, but their decisions remain distinct: mutation
  replay comes from the mutation authority, historical completeness comes from
  Experience.
- #2400 read surfaces should read the shared Experience projection for
  Experience history. Observability remains a dashboard/operations source, not
  a fallback source of durable Experience truth.
- Production measurements in #2375 must measure the real fail-closed Experience
  write path. Timing a best-effort observability write is not a substitute.

This closes the “ninth store with no ownership decision” gap without deleting
the specialized authorities that Experience is not designed to replace.
