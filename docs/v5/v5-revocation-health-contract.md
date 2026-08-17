# V5 Revocation and Health Surface Contract

**Status:** `spec`

**Parent issue:** `#848` (P3, registry/revocation/health/durable
observability).

**Child issues:** none assigned yet; this document is the task pack. The
wiring PRs are separate, single-purpose units and are **not** authorized
here.

**Mode:** Docs-first task pack only. No implementation, no new tests, no
wiring. This document changes exactly one file.

**Canonical base:** `main @ 2570cfa` (merge of PR `#895`). A successor
must re-verify its own exact SHA.

## 1. Source reality

Read from live source at the canonical base.

### 1.1 Revocation already has a first-class state machine

`lib/v5/trusted-key-resolver.js` defines the complete trust-root state
family:

- `STATES = {active, unknown, revoked, expired, unavailable, malformed}`
  and matching `REASONS` (`unknown_key`, `revoked_key`,
  `expired_key_metadata`, `key_lookup_unavailable`,
  `malformed_trusted_key_record`);
- **every non-active state is a hard rejection**: `revoked → revoked`,
  `expired → rejected`, `unavailable → key_lookup_unavailable`,
  `unknown → unknown_key`, `malformed → malformed_trusted_key_record` —
  the chain is **fail-closed by construction**: only `active` proceeds to
  signature evaluation (and `active` itself is bounded to a 44-byte SPKI
  digest at the verdict seam).
- `resolveTrustedKeyState` is the **single exported function** — the one
  place every trust-root decision must pass through.
- The record shape is bounded (`keyReference`, `status`, `expiresAt`,
  `publicKeySpkiDer`) with `FORBIDDEN_FIELDS` excluding private key
  material, secrets, tokens, endpoints, and PEM/JWK blobs.

### 1.2 What is missing

What does not exist is **the surface that changes a record's status into
`revoked`** and **the surface that observes the current trust state**:

- No module writes a revocation record; the resolver only *reads*
  records. The wiring question is bounded by `#848`'s own invariant 3:
  revocation is an admission **rejection surface**, not a trust grant —
  anything that fails to revoke must stay closed.
- No health endpoint reports agent trust state. The only existing
  health route is `GET /health` in `route-auth-policy.js`, an unauthenticated
  liveness probe that "exposes no graph content" — deliberately not a
  trust-state oracle.
- The registry wiring that would hold revocable records remains blocked
  on the receiver-held card problem (`A2A_AUTHORITY_FILE` unset in
  production, `a2aBoundary` null) — `#848`'s own blocking report.

### 1.3 The adjacent family

`lib/a2a/replay-store.js` is the existing replay owner (`#848` invariant 1:
no second store). Any health observation of in-flight exchange failures
keys off the same owner. The registry record shape is already defined
(`docs/v5/v5-registry-record-shape.md`, PR `#876`) and its `status`
vocabulary must map into the resolver's `STATES`, not introduce a second
vocabulary.

## 2. The decision

Two surfaces, both read-first, both shaped by existing machinery:

### 2.1 Revocation surface (write surface)

- The revocation surface is a **revocation record writer**: it records
  `keyReference → revoked` with an exact key set
  `{keyReference, status: 'revoked', revokedAt, reason, revokedBy}`.
  `status` is fixed to `revoked` — the resolver's `STATES` vocabulary is
  the only one; no new status is authorized.
- The writer does **not** touch verification results of already-imported
  packages; revocation changes *future* resolution only (a later
  verification-core amendment may re-evaluate in-flight trust, but that
  is a separate unit, explicitly out of this pack).
- The seam passes through `resolveTrustedKeyState`'s reader contract:
  whatever stores the record must present records the resolver already
  accepts. **No second key authority** (`#848` invariant 1).
- Fail-closed: an unresolvable revocation record (malformed
  `keyReference`, missing `revokedAt`, unknown `revokedBy` shape) is
  rejected whole; a rejected revocation never means "un-revoked".

### 2.2 Health surface (read surface)

- One bounded GET surface reporting the current trust state: bounded
  shape `{evaluationTime, agents: [{keyReference, keyState, expiresAt}]}`
  — the resolver's own `stateResult` vocabulary (`keyState: active |
  rejected`) flows through unchanged.
- The route joins the public-route policy as an authenticated-in-the
  narrowest way: liveness stays at `/health`; trust-state observation is
  **not** added to the liveness probe and stays behind the route auth
  policy as its own entry, consistent with "observability adds no new
  authority" (`#848` invariant 4).
- The health surface reads; it never writes, never triggers resolution
  side effects, and never influences a verdict.

### 2.3 Composition

Revocation and health share one contract: the **resolver's state
vocabulary**. The registry's record status (`#876`'s shape) maps into
`STATES`; the health surface reports through `resolveTrustedKeyState`;
the revocation writer produces records the resolver already validates.
Three surfaces, one vocabulary, no duplication.

## 3. What the wiring PRs may do

**Allowed**, in exactly this order — two PRs, one per surface:

- **Revocation PR:** the bounded revocation record writer and its
  storage seam; one test asserting `revoked → hard rejection` through
  the live resolver; exact-key validation; forbidden-field check at
  write time; no change to `resolveTrustedKeyState`'s read contract.
- **Health PR:** the bounded trust-state GET route under the route auth
  policy; one test asserting the response shape matches the contract
  and never carries private key material or package bodies; no change to
  `/health` or any verification logic.

**Forbidden (both PRs):**

- any change to `lib/v5/trusted-key-resolver.js`'s `STATES`, `REASONS`,
  `FORBIDDEN_FIELDS`, or the `active`-only proceed rule;
- any change to `lib/a2a/replay-store.js` beyond reading it for
  failure-state observation keys;
- any change to the package schema, the receipt plane, the writer
  kernel, `audit-log`, `ingest`, registry record shape (`#876`), export
  surfaces, `storage.js` lookups, tracing, metrics, or structured
  logging semantics;
- re-introducing a second key authority or second status vocabulary;
- a revocation that re-verifies or re-trusts past packages;
- exposing package bodies or private key material through the health
  surface (rejection already enforced by `FORBIDDEN_FIELDS` — the health
  PR must assert it by a failing test).

## 4. Acceptance preview (binding only in the wiring PRs)

1. Revocation PR: writing `revoked` for a known `keyReference` makes the
   next `resolveTrustedKeyState` return `revoked` with
  `reason: 'revoked_key'`; a malformed revocation record is rejected
   whole with no durable trace; existing 4437-test suite stays green.
2. Health PR: the response shape matches the contract exactly
   (`additionalProperties: false` semantics); the body contains no
   `publicKeySpkiDer`-sized private material; `/health` and
   `v2-status` are untouched; the suite stays green.
3. File-size, cycle, status-declaration, and acyclicity checks stay
   green; touched files stay within their ratchet limits; tarball smoke
   tests (`4C1`) and module reachability stay green; no ledger
   graduation happens.

## 5. Invariants

1. One key authority, one status vocabulary, one replay store —
   `#848`'s invariants 1 and 2 bind both surfaces.
2. Revocation is fail-closed in both directions: an unresolvable trust
   root rejects, and an unresolvable revocation record rejects — neither
   failure opens anything.
3. Observability adds no new authority: the health surface reports what
   the resolver already decided, nothing more.
4. The registry wiring blocker (`A2A_AUTHORITY_FILE` absent, no
   receiver-held cards) remains the registry record's own stop
   condition; this pack does not work around it — revocation records are
   stored where the resolver's reader contract is already satisfied, and
   the registry joins when its own unit reopens.

## 6. Non-claims

This record does not claim that any agent has ever been revoked; that
the health surface would survive an authority file appearing in
production (that is the registry's reopening condition, not this pack's
promise); that revocation re-evaluates past packages; that the health
route would be unauthenticated; or that tracing/metrics/structured
logging work is included — that is `#848`'s own separate child. It also
does not claim `resolveTrustedKeyState` is tested end to end for the
registry's records — it is not yet wired to any.

## 7. Sibling order

- [x] registry record shape — closed via `#876` (wiring blocked on cards)
- [ ] discovery surface — blocked on receiver-held cards (same blocker)
- [x] revocation — this task pack (docs-only, this file)
- [ ] health surface — same pack; separate wiring PR
- [ ] tracing/metrics/structured logging — separate unit, out of pack
- [ ] dead-letter and replay tooling — extends `lib/a2a/replay-store.js`,
  separate unit, out of pack
