# INGEST-SNAPSHOT-0 - External Ingest Snapshot Binding Scope

## Purpose

Define the exact contract that must exist before `/api/ingest` may accept
`github` or `markdown` into the approval queue. Those two source types are
refused today with `INGEST_SNAPSHOT_REQUIRED`; this gate specifies what would
make accepting them safe, and what must not be built along the way.

This gate changes no runtime code, no schema, no test, and no dependency. It
records source reality and freezes scope. Implementation requires a separately
authorized successor from the then-current canonical `main`.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch: `main`
- Scope-definition base: `ccc1a4869a6c84bcf90f4560fcf6c470860fdeab` (PR #97)
- Predecessor evidence: PR #92, #93, #94, #95, #96
- Current gate: `INGEST-SNAPSHOT-0_EXTERNAL_SOURCE_BINDING_SCOPE`
- Authorized successor after separate review and closeout:
  `INGEST-SNAPSHOT-1_SOURCE_BINDING_CONTRACT_TESTS`

The base records the source inspected by this document. It is not an
implementation authorization.

## Governing Sources

- `docs/current-operating-roadmap.md` (execution order and Stream B gates)
- `lib/ingest.js`, `server.js`, `storage.js`
- `adapters/github-adapter.js`, `plugins/repo-memory.js`
- `test/ingest-snapshot-gate-boundary.test.js` (fail-closed gate lock)

## Governing Invariants

These hold today and must survive this gate unchanged.

1. The queue accepts an allow-list, never a deny-list. An unrecognized source
   type is refused, not passed through.
2. The executed payload is the reviewed payload. The snapshot is re-hashed and
   compared immediately before execution (`server.js:1162`).
3. Snapshot hashing is key-order independent (`lib/ingest.js:21`) and carries
   its algorithm prefix (`sha256:`), so a digest migration cannot masquerade as
   the same hash.
4. Uniqueness is enforced by the database, not by application code —
   `approval_key` is UNIQUE (`storage.js:106`).
5. Lease claim, heartbeat and expiry recovery are compare-and-swap based
   (`storage.js:597-671`).
6. A receipt states `state_transition_not_asserted` (`server.js:1200`). It must
   never be upgraded to a committed-write claim without transactional evidence.
7. A refusal returns no payload, no snapshot hash and no idempotency key.

## Canonical Source Reality

Observed at the base above. Each row is a read of the named line, not a search
result.

| Fact | Evidence |
| --- | --- |
| The fail-closed branch is a single explicit allow-list | `lib/ingest.js:150-153` |
| `handleIngest` accepts all four source types and does **not** re-enforce the gate | `lib/ingest.js:118-121` |
| `handleIngest` has exactly one runtime caller, and it runs after the gate on `snapshot.payload` | `server.js:1179` |
| The tree listing is requested for a branch, not a commit | `adapters/github-adapter.js:71` |
| File content is fetched from `raw.githubusercontent.com/.../{branch}/{path}` | `adapters/github-adapter.js:96` |
| The per-file record carries owner, repo, branch, path, content, lastModified — and no SHA | `adapters/github-adapter.js:112-119` |
| The stored provenance ref is itself branch-pinned: `owner/repo/path@branch` | `plugins/repo-memory.js:133` |
| No `commit`, `sha` or `oid` appears anywhere in the adapter | `adapters/github-adapter.js` (whole file) |
| Content is fetched at approval time, not at queue time | `plugins/repo-memory.js:152,349` |
| `approvalKey` embeds `snapshotHash` | `server.js:1234` |
| Idempotency key derivation is sha1 truncated to 16 hex characters (64 bits) | `lib/ingest.js:18` |
| `actor` is hardcoded `'http-api'`; `workspaceId` is hardcoded `'default'` | `server.js:1135,1196` |
| `metadata.auditRefs` is always written empty | `server.js:1198` |

## The Gap This Gate Exists To Close

The queue can bind an approval to *bytes it was shown*. It cannot bind an
approval to *a source at a point in time*. For `manual` and `decision` the
request body is the content, so those two are equivalent. For `github` and
`markdown` they are not: the request names a location, and the content is read
later.

Two consequences follow, and both are why the gate is closed:

- **Time-of-check to time-of-use.** Content is read at approval time
  (`plugins/repo-memory.js:152`). A reviewer approves a branch name; whatever
  that branch points at when execution runs is what gets ingested. Nothing
  detects the difference, because the snapshot hash covers the *request*, not
  the *content*.
- **No immutable source identity.** A branch name is mutable by design. Without
  a commit SHA — or, for markdown, a per-file content hash — there is no
  identifier that can be re-resolved later to prove what was approved.
- **The mutability outlives the request.** The provenance written into the
  graph is itself branch-pinned (`plugins/repo-memory.js:133`, `sourceRef` is
  `owner/repo/path@branch`). So the loss is not confined to the approval
  window: after ingestion there is still no stored identifier that resolves
  back to the exact bytes admitted. Any later audit of "what did we learn from
  this repository" can name a location but cannot reproduce a version.

## Required Contract

### C1 - Immutable source identity

`github` requests resolve the ref to a commit SHA **before** the approval is
queued, and the queued snapshot carries that SHA. `markdown` requests carry a
per-file content hash for each file in scope. A request whose ref cannot be
resolved to an immutable identifier is refused; it is not queued optimistically.

### C2 - Content snapshot at queue time

The content hash recorded at queue time is the hash of the content that will be
ingested. Execution re-derives the hash from the immutable identifier and
compares. A mismatch fails the approval as
`execution_outcome_unknown:snapshot_drift` rather than ingesting the new
content. This extends the existing pre-execution re-hash
(`server.js:1162`) from the request to the content.

### C3 - Approval reference immutability

The approval record binds: source type, immutable source identifier, content
hash, requester identity, and decision. None of these may be rewritten after
the decision is recorded. The existing UNIQUE `approval_key` stays the
uniqueness authority.

### C4 - Idempotency that can actually collide

Today `approvalKey` embeds `snapshotHash` (`server.js:1234`), so the same
client key submitted with different content produces a different key and
silently opens a **second** approval instead of raising a conflict. The
contract must separate the two concerns:

- a caller-supplied idempotency key identifies the *request*, and a repeat with
  different content is a **conflict**, not a new approval;
- the content hash identifies the *content*, and is what execution verifies.

Key derivation moves off sha1-truncated-to-64-bits (`lib/ingest.js:18`) to a
full-width digest. 64 bits is below the collision margin appropriate for a
value that gates a mutation.

### C5 - Replay protection

An accepted request carries a validity window. An approval that is not executed
inside its window expires rather than remaining executable indefinitely. Replay
of an already-executed request is refused by identity, not by side effect.

### C6 - Distinguishable actors

`actor` and `workspaceId` stop being hardcoded (`server.js:1135,1196`) so a
requester and an approver are distinguishable in the record. Without this,
self-approval cannot be detected, let alone refused. Whether self-approval is
*refused* is a policy decision reserved for a later gate; this gate only
requires that it be *visible*.

### C7 - Two-way receipt/audit linkage

`metadata.auditRefs` stops being written empty (`server.js:1198`) so a receipt
can be resolved to its audit events and back.

## Allowed Scope

- This document.
- Task-pack and roadmap updates that record it.

## Forbidden Scope

Nothing in this list may change under this gate.

- Any runtime file: `lib/ingest.js`, `server.js`, `storage.js`, adapters,
  plugins.
- The receipt schema, the approval schema, or any migration.
- Enabling `github` or `markdown` ingest, partially or behind a flag.
- Widening `handleIngest`, or moving the gate into it.
- Network calls to resolve refs "just to see whether it works".
- A new dependency. Ref resolution and hashing must be assessed against
  existing primitives first; adopting anything external is a separate GO/NO-GO
  per the dependency rule.
- Any change to the `manual` or `decision` paths, which are already queueable
  and out of scope here.

## Acceptance Criteria

This gate closes when all of the following hold.

1. Every requirement C1-C7 states, for the current base: what exists, what is
   missing, and what the contract must be. No requirement is left as a
   direction of travel.
2. Every source-reality claim carries a file and line, and every line has been
   read rather than matched.
3. The forbidden-scope list is at least as specific as the required contract.
4. Acceptance for the successor gate is expressed as tests that can fail, not
   as properties that can be asserted vacuously.
5. `git diff --check` passes and the worktree is clean.
6. The full suite is unchanged and green, because nothing executable changed.

## Competitive register rows consulted

Required by the register rule that a gate may not close without evaluating the
rows mapped to it. INGEST-SNAPSHOT-0 does not appear in the roadmap's
gate-to-register table because the ingest hardening stream post-dates it, so the
applicable rows are mapped here.

| Row | Bearing on this gate | Disposition |
| --- | --- | --- |
| `CE-002` | Missing, malformed or error verdicts are not `ALLOW` | **ADOPT.** The allow-list at `lib/ingest.js:150` already implements it; C1 must not introduce an optimistic path around it |
| `CE-007` | A valid signature alone proves neither the right artifact nor the right semantic claim | **ADOPT.** This is precisely C1/C2: a hash over the request is not a hash over the content |
| `CE-008` | Input digest, output digest, signer identity and semantic claim must be verified together | **ADAPT.** C2 covers input/content digest. Output-state verification belongs to Action Integrity F4, not here |
| `CE-009` | Approval execution must be atomic or idempotent; crash and replay must not re-produce side effects | **ADOPT.** C4 and C5. PR #93 and #96 supply the claim and lease halves; content binding is the missing half |
| `CE-013` | Workspace/tenant scope and freshness must be explicitly bound | **ADAPT.** C6 makes actor and workspace real; tenant isolation policy stays an enterprise-gate decision |
| `RTG-001` | Approval execute/finalize crash or replay can re-produce side effects | **OPEN**, partially addressed. Narrowed by C5; full closure needs Action Integrity F3/F4 |
| `RTG-002` | A public in-process mutation path can skip gate coverage | **CLOSED for this path, monitored.** Verified: `handleIngest`'s only runtime caller runs after the gate, and `test/ingest-snapshot-gate-boundary.test.js` now asserts the asymmetry so a second caller cannot appear silently |

## Stop Conditions

Stop and report without producing a successor if any of these hold.

- The GitHub adapter cannot resolve a ref to a commit SHA without a new
  dependency or a new network permission.
- Resolving a ref at queue time would require a credential the queue path does
  not already hold.
- Widening the idempotency key would break the UNIQUE constraint on existing
  rows without a migration, which is out of scope here.
- Making `actor` real requires an identity source that does not exist yet.
- Any proposed change would make an unresolved case queueable rather than
  refused.
- The full suite is not green at the base, for any reason.

## Non-Claims

This document does not implement source binding, does not enable GitHub or
markdown ingest, does not add replay protection, does not change any schema,
does not authorize a dependency, does not claim that graph state is
transactionally committed, does not close `RTG-001`, and does not assert that
the approval path is exactly-once.
