# Company Brain Decision Ingest — Batch Operation Contract (#4483)

## Scope

Bounded to `ingestDecision` in `lib/company-brain-ingest.js`. Other batch paths
(Repo Memory, manual/api ingest) are out of scope for this change.

## Stable operation-ID owner

The operation ID is **client-supplied** via `input.operationId` or
`input.mutationOperationId`. The plugin never invents an ID. Callers that
supply no ID keep the legacy non-journaled behavior (backward compatible).

## Atomic mutation unit

When an operation ID is supplied and the active Graph exposes
`Graph.runMutationOnce()` (SQLite and JSON backends), the entire decision batch — node/edge
proposals for the rationale, alternatives and links — runs as one atomic
mutation unit inside a single `runMutationOnce(operationId, ...)` call. A
mid-batch failure rolls back all canonical writes; no partial accepted work
remains.

## Composite receipt

The batch record is the journaled result, stored once under the operation ID
and readable with `graph.getCommittedMutationResultByOperation(operationId)`.
It carries `decisionId`, `added` and the per-proposal `admission` summary, i.e.
what the batch committed. The returned value adds `operationId` and
`replayed`. No canonical admission receipt is chained for a decision batch, so
`receiptId` is `null` unless the journal returns one; per-proposal admission
audit events are unchanged.

## Semantics

- **allow**: proposals admitted; canonical writes committed atomically.
- **review**: one or more proposals require review; the batch still commits
  its allowed subset inside the same unit (admission stays the parent
  boundary per proposal).
- **reject**: a rejected proposal is recorded in `admission` with no canonical
  write for that proposal; the batch unit still completes for the rest.
- **mid-batch failure**: the transaction rolls back; retrying with the same
  operation ID re-runs as a first execution (no duplicate accepted work) and
  returns the stored result on a completed replay.
- **no ID**: legacy path, no journal, no replay.
- **ingest counters**: the `decision` ingest-status count is updated only after
  the batch commits, and not again on a replay.

## Backend

Both SQLite and JSON backends expose `Graph.runMutationOnce()`. SQLite runs the
batch in one SQLite transaction; JSON runs it through the JSON mutation
journal. A Graph without `runMutationOnce` fails closed with
`DURABLE_MUTATION_JOURNAL_UNAVAILABLE` when an ID is supplied.

## Proof

`test/company-brain-decision-operation-id.test.js` runs a real Kernel on each
backend: a crash on the third proposal leaves the graph unchanged, a retry with
the same ID commits once, and a second retry replays without new writes.
