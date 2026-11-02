# Company Brain Decision Ingest — Batch Operation Contract (#4483)

## Scope

Bounded to `ingestDecision` in `lib/company-brain-ingest.js`. Other batch paths
(Repo Memory, manual/api ingest) are out of scope for this change.

## Stable operation-ID owner

The operation ID is **client-supplied** via `input.operationId` or
`input.mutationOperationId`. The plugin never invents an ID. Callers that
supply no ID keep the legacy non-journaled behavior (backward compatible).

## Atomic mutation unit

When an operation ID is supplied and the active Graph backend supports
`Graph.runMutationOnce()` (SQLite), the entire decision batch — node/edge
proposals for the rationale, alternatives and links — runs as one atomic
mutation unit inside a single `runMutationOnce(operationId, ...)` call. A
mid-batch failure rolls back all canonical writes; no partial accepted work
remains.

## Composite receipt

The result carries a single `operationId`, `replayed` flag and `receiptId`
(from the journal receipt) for the whole batch, in addition to the existing
per-proposal `admission` summary.

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

## Backend

SQLite only. On a backend without `runMutationOnce` the call fails closed with
`DURABLE_MUTATION_JOURNAL_UNAVAILABLE` when an ID is supplied.