# Mutation Journal Decision - Source Reality

## Checkpoint

- Repository: `ali-ulu/huqan`
- Source base: `main @ 7b9c32de3d1ef9e2179c3d759710ecfb3a8bc9e6`
- Previous checkpoint: `CONNECTOR_PROVENANCE_CONTRACT_TESTS_CLOSEOUT_GREEN`
- Decision: `DEFER_PLUGIN_JOURNAL_MIGRATION`
- Mode: source-reality and decision only

This task-pack records the current mutation boundaries and makes the smallest
safe decision. It does not authorize a runtime migration.

## Source authority

Use this order when evidence conflicts:

1. live source and reachable production call paths at the pinned base;
2. current executable tests;
3. `docs/current-operating-roadmap.md`;
4. historical or skipped contract tests.

The `huqan_current` MCP was unavailable during this review. The decision is
therefore based on the pinned source, the code graph, and executable tests.

## Existing durable boundary

The durable mutation journal is integrated only when `Kernel.learn()` receives
a non-empty caller-provided `mutationOperationId`.

The integrated path:

1. requires the SQLite Graph backend;
2. uses `Graph.runMutationOnce()` with the supplied operation ID;
3. executes learning, the journal write, and the canonical receipt-chain write
   inside one SQLite transaction;
4. replays a stored result without invoking the mutation callback again;
5. restores the mutable in-memory Graph indexes if the transaction fails;
6. runs Graph save and other post-commit effects only after the first commit.

The canonical persisted MCP approval path owns a stable operation ID by binding
the approval ID to `mutationOperationId`. A plain `Kernel.learn()` call does not
invent an operation ID.

## Mutation classes

| Class | Current path | Current guarantee | Deliberate limit |
| --- | --- | --- | --- |
| Approval-backed durable learn | MCP approval -> `Kernel.learn()` -> `Graph.runMutationOnce()` | SQLite transaction, replay, canonical chained receipt | Limited to the integrated approval-backed learn path |
| Caller-forwarded learn | Provenance ingest may forward `mutationOperationId` | Durable only when a caller supplies the ID and SQLite is active | The ingest layer does not generate an ID |
| Admission-gated plugin proposals | Company-brain and repo-memory call `Kernel.proposeNode()` / `Kernel.proposeEdge()` | Per-proposal admission and audit behavior | No batch transaction, operation replay, or receipt-chain guarantee |
| Best-effort audit writes | CLI and server audit append paths | Audit attempt is isolated from command execution | Not a mutation journal or atomic outcome proof |
| Other direct learning | MCP `axiom.learn`, adapters, and LLM-memory paths without an operation ID | Existing learning behavior | No durable replay identity or canonical journal receipt |

## Reachable plugin writers

The production plugin inventory found three write-capable plugin families:

- CLI company-brain manual ingest invokes a variable multi-proposal batch.
- CLI company-brain decision ingest writes the decision, rationale,
  alternatives, and their relationships as a multi-proposal batch.
- CLI repo-memory GitHub and Markdown ingest write variable-size repository,
  file, section, and relationship batches.
- The default LLM-memory plugin may learn after an unknown answer and then save
  the Graph. This is an asynchronous learning path, not an ingest batch.

No other production plugin was found making direct Graph-domain mutations at
the pinned base.

These are not one migration unit. Company-brain and repo-memory need separate
batch contracts. LLM-memory needs separate async failure, retry, and
idempotency semantics. Approval lifecycle audit append is also separate from a
Graph-domain mutation journal.

## Company-brain source reality

Company-brain no longer writes raw Graph nodes or edges directly. It uses the
Kernel proposal seam.

Manual and decision ingestion still compose multiple proposal calls. Those
calls are admission-aware, but the whole plugin operation is not a single
durable transaction. A failure after an earlier accepted proposal can leave
partial observable work.

Current tests prove proposal admission behavior and no-write-on-review. They do
not prove:

- atomic multi-proposal commit;
- exactly-once replay of a plugin operation;
- one canonical receipt per plugin operation;
- rollback after a mid-operation failure;
- recovery after process restart.

The skipped `faz2-universal-mutation-boundary` contract still describes
company-brain as a raw direct Graph writer. That description is historical and
must not override the current proposal-based source.

## Decision

`DEFER_PLUGIN_JOURNAL_MIGRATION`

Do not retrofit company-brain, repo-memory, or every plugin mutation into
`Graph.runMutationOnce()` in this gate.

Reasons:

1. No current product requirement establishes retry-safe company-memory batch
   ingestion as a release blocker.
2. A correct migration needs four decisions that current source does not own:
   stable operation-ID ownership, transaction unit, composite receipt shape,
   and non-SQLite behavior.
3. Generating an ID inside a plugin would not provide replay identity across
   retries.
4. Requiring a new caller ID would change public behavior.
5. Treating each proposal as a separate journal operation would preserve
   partial-commit risk and would not satisfy batch atomicity.
6. A universal migration would broaden the change across unrelated plugin and
   connector paths without evidence that the broader abstraction is needed.
7. Changing ordinary `Kernel.learn()` to require a journal identity would be a
   public behavior change and is not necessary to decide plugin batch policy.

This is a bounded YAGNI decision, not a claim that the current boundary is
durable enough for every future product surface.

## Required future trigger

Open a dedicated migration chain only when at least one accepted product path
requires retry-safe plugin mutation after timeout, crash, or client replay.

The authorization must identify:

- the exact public entry point;
- the caller that owns a stable operation ID;
- the complete atomic mutation unit;
- the canonical receipt payload and workspace-chain policy;
- replay result semantics;
- partial admission/review/reject semantics;
- SQLite-only fail-closed behavior or a separately approved backend design;
- backward compatibility for callers that do not provide an operation ID.

If the trigger is externally initiated ingest, prefer a stable
caller-controlled operation ID and fail closed when the new durable entry point
does not receive one. Do not generate a random ID inside a plugin and call that
replay protection.

## Minimum future proof

If a transactional company-brain path is authorized later, its tests must prove:

1. first execution commits the complete manual or decision batch once;
2. replay with the same operation ID invokes no proposal callback and returns
   the stored result;
3. failure after an early proposal leaves no node, edge, audit event, journal
   entry, or receipt from the failed operation;
4. JSON backend rejects before executing a proposal;
5. one canonical receipt is committed per operation and replay returns the
   same receipt ID and hash;
6. missing, blank, or conflicting operation IDs fail closed on the new durable
   entry point;
7. existing callers without an operation ID remain behavior-compatible unless
   a separate breaking-change gate explicitly decides otherwise.

## Separate cleanup backlog

The stale historical wording in
`test/faz2-universal-mutation-boundary.contract.test.js` should be reconciled in
a dedicated test-contract cleanup gate. This decision does not edit or enable
that skipped test.

## Non-claims

This decision does not claim that:

- every plugin mutation is durable, atomic, or replay-safe;
- proposal admission is equivalent to transaction commit;
- best-effort audit append proves mutation outcome;
- JSON Graph supports the durable mutation journal;
- external connectors share one universal mutation boundary;
- current direct plugin paths are safe for automatic retry;
- V5, ecosystem trust, authorization, or public certification is complete.

## Allowed successor

No runtime successor is automatically authorized.

The next roadmap item may proceed only after this docs-only decision is
independently reviewed, merged at its exact head, and closed out on canonical
`main`.
