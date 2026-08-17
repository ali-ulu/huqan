# V5 Immutable Source Snapshot — Hash + Version Contract

**Status:** `spec`

**Parent issue:** `#847` (P2, durable evidence plane) — child 4: *"Immutable
source snapshot carrying hash + version."*

**Child issue:** none assigned yet; this document is the task pack. The
wiring PR is a separate, single-purpose unit and is **not** authorized here.

**Mode:** Docs-first task pack only. No implementation, no new tests, no
wiring. This document changes exactly one file.

**Canonical base:** `main @ 6d42dd5` (merge of PR `#892`). A successor must
re-verify its own exact SHA; every factual claim below is checkable by grep
at that base.

## 1. Source reality

Read from live source at the canonical base. The V5 evidence plane has a
hash machinery and a snapshot vocabulary, but they live in different planes
and the package cannot currently carry one.

### 1.1 The package carries no source binding

`schemas/v5/shared-trust-package.schema.json` top-level properties are
`schemaVersion`, `packageId`, `issuer`, `subject`, `verdict`, `receipt`,
`evidence`, and the two `routeReceipt` shapes (receipt-nested and
top-level). There is **no source snapshot field** — no `sourceType`,
`sourceRef`, `contentHash`, or `version` binding anywhere in the schema.
`lib/v5/runtime-writer.js::buildPackage` emits none of that material
either; its input is identity, subject, verdict, non-claims, and the three
optional metadata objects. A writer-produced package therefore has **no
immutable anchor to the source it was written about** — only a `packageId`
with no binding.

### 1.2 The immutable-hash machinery exists, in the receipt plane

`lib/v5/public-trust-receipt.js` already implements exactly the contract
family this child needs, one plane down:

- `snapshotDataObject`/`hasExactDataKeys` — exact-key-set canonical views;
- `snapshotCanonicalJson` — deterministic canonical JSON of a bounded
  object;
- `verifySourceBundle(sourceBundle, internalReceiptHash)` — re-derives the
  bundle's canonical form and verifies it against the receipt's
  `internalReceiptHash`; tampered bundles fail as
  `INVALID_SOURCE_BUNDLE`, matching `snapshotHash` vs
  `sha256(ingestApprovalSnapshotBindingView(...))` pattern of the V4
  ingest path (`lib/ingest.js:517`, `lib/ingest.js:536`).
- `verifyExportedBundle` does the cryptographic verification underneath.

V4's external ingest (`lib/ingest.js`) carries the operational model the
package layer should mirror, not copy: a versioned snapshot type
(`huqan.external-source-snapshot.v1`), bounded field sets per source type,
and a hash over a **canonical binding view** re-derived at verification
time — never stored as an opaque blob.

### 1.3 Nothing connects the two

No test asserts that a package's content hash round-trips through the
validator; no production caller supplies source material; and the format
document (`docs/v5/v5-shared-trust-package-format.md`) names no snapshot
section. The hash machinery is ready, the package shape is ready, and the
binding between them is written in no document.

## 2. The decision

The writable contract is **one nested object: `sourceSnapshot` inside
`receipt`** — the same location discipline as `routeReceipt`, so the
receipt remains the package's single evidence envelope.

- **Shape:** exact key set `{snapshotId, snapshotVersion, hash, algorithm}`.
  `snapshotVersion` is a versioned snapshot type string
  (`huqan.external-source-snapshot.v1` — the V4 constant, not a new
  invention); `algorithm` is fixed to `sha256`; `hash` is a hex string over
  the canonical binding view of the snapshot. `additionalProperties: false`,
  all four required.
- **What is hashed:** a **bounded canonical view**, not the raw snapshot.
  The exact per-version field set lives in the wiring PR (V4 already
  defines it per source type). The pack does not authorize a new hash
  algorithm, a new version family, or a raw-byte digest.
- **Immutability claim:** a package carrying `sourceSnapshot` asserts the
  source looked like that view when the package was written. The writer
  may not re-hash, re-version, or "fix up" a supplied snapshot — it
  carries it or rejects it, fail-closed. Any mismatch between the
  supplied snapshot and its claimed hash is a write-time rejection, not a
  stored correction.
- **Identity boundary:** the snapshot may not contain agent identities,
  trust roots, or key material; that material belongs to the identity and
  registry planes. `hasSecretLookingValue` semantics from the receipt
  plane apply at write time.

## 3. What the wiring PR may do

**Allowed**, in exactly this order:

1. `schemas/v5/shared-trust-package.schema.json` — add the
   `receipt.sourceSnapshot` object with the exact key set above;
   update the conformance matrix with one new `covered` area
   (`source snapshot binding`, future gate: cross-version snapshot
   migration policy); update the format document's receipt section.
2. `lib/v5/runtime-writer.js` — accept optional bounded `sourceSnapshot`
   input: exact-key validation, hash/algorithm sanity, no re-hashing —
   carry or reject. `buildPackage` passes it into `receipt`. This is the
   same schema-convergence pattern as the route receipt (PR `#892`).
3. `lib/http/v5-package-import-route.js` — may accept an optional bounded
   `sourceSnapshot` input through the same fail-closed chain.
4. One convergence test: written package with source snapshot validates
   (`validateSourceBundle`-style re-derivation passes); tampered snapshot
   or mismatched hash rejected at write time; absent input stays absent.

**Forbidden:**

- changes to `lib/v5/public-trust-receipt.js`, `lib/ingest.js`, or the V4
  ingest wire format — the receipt plane and V4 surface are not this
  unit's authority;
- a top-level `sourceSnapshot` shape, a raw-bytes `contentHash` field, or
  more than one algorithm — one shape, one algorithm;
- any change to the validator's existing shapes, `NOT_YET_WIRED` ledger
  edits, persistence changes, export/GET surfaces, discovery, registry,
  revocation, health, tracing, metrics, logging, or `POST /api/v5/packages`
  semantics beyond the single optional field;
- any claim that a carried source snapshot implies provenance,
  authorization, or signature — it is a content binding only.

## 4. Acceptance preview (binding only in the wiring PR)

1. File-size, cycle, and status-declaration checks stay green; touched
   files stay within their ratchet limits.
2. Existing package tests stay green; a written package with source
   snapshot passes the validator, and one with a tampered snapshot is
   rejected — both directions asserted by tests, not inspection.
3. Tarball smoke tests (`4C1`) stay green — the route's V5 require stays
   lazy and conditional.
4. `node --test test/module-reachability.test.js` stays green; no ledger
   graduation happens in the wiring PR.

## 5. Invariants

1. A module graduates off `NOT_YET_WIRED` only by acquiring a real caller —
   this unit fixes the shape a real caller can write; it graduates nothing.
2. Fail-closed: a snapshot the writer cannot validate is rejected whole;
   no partial or corrected snapshot is ever emitted.
3. The snapshot is a **content binding, not an identity claim**: it names
   neither an agent nor a trust root, and proves nothing about who wrote
   the package — only about what the source looked like.
4. Existing V4 receipt, package, and ingest wire formats are not modified
   as a side effect.
5. `#847`'s own invariant 4 governs the child after this: the atomicity
   unit (child 5) must assert by a failing test that a partial write is
   unobservable; this pack leaves the durability layer to it.

## 6. Non-claims

This record does not claim that any package has ever carried a source
snapshot; that `verifySourceBundle` is called anywhere in production; that
the snapshot content is itself verified for authorization or provenance;
that cross-version snapshot migration exists or is imminent; or that the
writer's existing `schemaVersion` field has any relation to snapshot
versions.

## 7. Unit order

- [x] child 1 — `#872` source-reality (closed)
- [x] child 2 — `#875` first production caller (closed; `#888` merged)
- [x] child 3 — Route Receipt write contract (closed via `#892`)
- [x] child 4 — this task pack (docs-only, this file)
- [ ] child 5 — atomicity between graph mutation and audit/receipt emission
- [ ] child 6 — transactional outbox and replay on the durable store

The reader side of export stays out, with the registry's receiver-held-card
blocker; it joins when its own bounded unit opens.
