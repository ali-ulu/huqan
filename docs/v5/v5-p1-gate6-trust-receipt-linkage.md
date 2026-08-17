# V5 P1 Gate 6 — Trust Receipt Linkage Requirements

**Status:** `spec`

**Parent issue:** `#846` (P1, agent identity enforcement chain). Gate 6
of the eight gates named in
`docs/v5/v5-agent-identity-closeout-audit.md`.

**Child issue:** none assigned yet; this document is the task pack. The
implementation unit is a separate, single-purpose PR and is **not**
authorized here.

**Mode:** Docs-first task pack only. No implementation, no new tests, no
wiring, no changes to any receipt format, schema, or writer. This
document changes exactly one file.

**Canonical base:** `main @ a0cdc47` (merge of PR `#899`). A successor
must re-verify its own exact SHA.

## 1. Source reality

### 1.1 What the threat model assigns to this gate

The threat model is explicit about what Gate 6 must deliver, and it is
not "receipts":

> "A control must emit not just a decision but evidence that can be
> linked to a Trust Receipt (gate 6). A receipt carrying only
> 'denied' cannot answer the question that makes a deterministic trust
> boundary meaningful: **Which trust assumption failed?**"

Gate 6 is the gate that closes the loop between the identity
enforcement plane (this pack's subject) and the receipt plane (which
already exists as P0 closeout and task-pack work:
`v5-d3-public-trust-receipt.md`, `v5-route-receipt-write-contract.md`,
`v5-package-atomicity-contract.md`,
`v5-package-outbox-replay-contract.md`). The threat model also
includes linkage in Gate 2's hook-selection criteria — criterion 4,
"Produces Trust-Receipt-linkable evidence, under the namespace rules"
— so this gate's rules are what Gate 2 compares candidates against,
not a decision Gate 2 must make.

### 1.2 What the existing planes already prove

Four facts are already in live source and this pack inherits them
rather than re-authorizing:

- **The namespace rules are fixed** (threat model, six namespaces):
  `identity.invalid_claim`,
  `identity.workspace_binding_failed`,
  `delegation.scope_exceeded`, `delegation.chain_invalid`,
  `connector.context_invalid`, `connector.revoked` — with the
  no-fallthrough rule ("if it does, the receipt cannot evidence which
  security property was engaged") and the controlled-vocabulary rule
  (vocabulary grows under review, not per failure site).
- **The refusal-read-identically precedent exists**:
  `lib/a2a/bounded-exchange.js` produces a refusal reason that reads
  identically in the conformance report and in the HTTP response —
  the working form of "linkable evidence".
- **The receipt plane's shape discipline exists**: the D3 public
  receipt (`exportPublicTrustReceipt()`) carries `publicReceiptId`,
  `binding`, `integrity.signature.keyId`, and a disclosure allowlist
  of exactly seven fields; the route receipt contract fixes
  `receipt.routeReceipt` to `routeId`, `hopCount`, `metadata`; the
  atomicity pack fixes that a written package and its audit event are
  one observable unit.
- **The clock rule exists**: "a receipt that cannot say which clock it
  was judged against cannot be reproduced" — Gates 3, 4, and 5 all
  write their decisions against receiver-owned `evaluationTime` and
  name it in evidence.

What does **not** exist, and this is the gap Gate 6 writes into: a
formal contract stating which fields link an identity-plane decision
to a receipt, in which direction, by what reference mechanics, and
with what reproduction property. The identity enforcement chain
(Gates 3–5) defines reasons and evaluation semantics; the receipt
plane defines formats; nothing yet states that an enforcement
decision's reason, clock, workspace, and delegation record must be
present — with those exact values — in the receipt it links to.

### 1.3 What the conformance chain already carries

The closeout audit records `V5-IMPL-1D conformance linkage` — the
fixture/schema/validator/conformance pipeline
(`schemas/v5/agent-identity-conformance.js`,
`test/v5-agent-identity-conformance.test.js`). That pipeline is the
**schema-level** linkage for identity conformance evidence. Gate 6 is
not a replacement for it; it is the **runtime decision-level**
linkage: the properties an enforcement decision must carry so that a
receipt referencing it can reproduce its judgment. A successor must
say which direction is new ground: the conformance pipeline already
proves that conformance evidence is linkable; Gate 6 must prove that
*decisions* are.

## 2. The decision

Gate 6 writes the **linkage requirements** — what an identity-plane
decision must carry, and how a receipt must reference it — without
choosing where enforcement runs (Gate 2), without altering any
receipt format (that is the receipt plane's authority), and without
implementing linkage on any path.

### 2.1 The linkage contract

A decision links to a Trust Receipt when all five properties hold:

1. **Reason traceability**: the receipt carries the decision's
   `reason_category` verbatim — one of the fixed namespaces, never a
   generic denial. A receipt whose decision says `denied` while its
   linked decision names a namespace member is a broken link, and the
   break is detectable because the vocabulary is bounded.
2. **Clock reproducibility**: the receipt names the same
   `evaluationTime` the decision was judged against. A receipt that
   cannot reproduce the judgment under its own clock fails linkage —
   the threat model's own rule, now stated as a testable property.
3. **Binding context**: the receipt names the `workspaceId` the
   decision was bound to (ADR-011 primitive); for delegation-bearing
   decisions, the receipt records the delegation record reference
   whose scope was judged — a delegation evaluated in a different
   workspace is a different decision (Gate 4).
4. **Lifecycle state**: the receipt names the lifecycle event
   observed — revoked, expired, rotated, or none — because revocation
   outranks expiry and the receipt must say which (Gate 5); the
   compromised receipt must also carry the replay reservation result.
5. **Directional integrity**: linkage references the decision from
   the receipt (`publicReceiptId` → decision material), not the
   receipt from the decision. The decision must be reproducible from
   its own evidence; the receipt must be verifiable as having carried
   that evidence under its signature (D3's checksum-covers-signature
   ordering already provides the receipt side).

### 2.2 The reproduction property (the acceptance test in one sentence)

> Given a receipt and its referenced decision evidence, the judgment
> must be **recomputable**: the same inputs (record state, lifecycle
> event state, receiver clock, workspace, delegation scope) produce
> the same decision and the same reason — and any divergence means
> either the receipt is forged or the evidence is lost, both of which
> are failures the receipt must say so, not default to valid.

This is the property that separates linkage from correlation:
correlation says the two artifacts exist near each other; linkage
says one **reproduces** the other under the deterministic rules
Gates 3–5 fixed.

### 2.3 What linkage must not become

- **Not a new receipt format**: the D3 format, the route receipt
  shape, and the package format are each another plane's contract.
  Gate 6 adds no field to any of them; it requires that the fields
  that already exist (reason, clock, workspace, delegation, lifecycle)
  be *present and consistent* in whatever receipt carries a decision.
- **Not cross-agent trust**: a link says "this receipt references this
  decision"; it does not say the decision's subject is trusted. The
  conformance matrix's future gate keeps that authority.
- **Not persistence**: where linked decisions are stored and for how
  long is the storage plane's question; Gate 6 defines the linkage
  property, not its shelf life.

**Two deliberate non-decisions:**

- **Linkage storage and retrieval mechanics** stay with the storage
  plane — a receipt's ability to *reference* is a format/contract
  property, which is what this gate governs; how a verifier
  *fetches* the referenced decision is not.
- **Hook location stays Gate 2's**, and linkage is a property the
  hook selection criteria already demand (criterion 4) — this gate
  gives that criterion its testable content.

## 3. What the implementation unit may do

**Allowed**, in exactly this order — a single bounded PR whose subject
is the linkage property's *shape* as executable contract, not
linkage on any path:

1. A bounded module (or equivalent home) implementing the five
   linkage properties as pure, deterministic checks — reason
   verbatim, clock reproduction, binding context, lifecycle state,
   directional integrity — consistent with the pure-module discipline
   of the Gate 3–5 packs and the writer kernel discipline of PR
   `#894`/`#895`.
2. One conformance test set asserting, for each fixed namespace: a
   decision's evidence round-trips through a receipt and recomputes
   the same judgment and reason; a forged or degraded link (mismatched
   clock, generic denial, wrong workspace, collapsed lifecycle) fails
   linkage with a detectable, namespace-bearing reason.
3. A compatibility assertion against the existing planes: the
   bounded-exchange refusal-read-identically precedent satisfies the
   linkage property for the exchange surface as-is; the D3 format's
  integrity ordering satisfies the receipt side; the test must say
  which surfaces already satisfy the property and which remain
  `NOT_YET_LINKED`.

**Forbidden:**

- any change to `lib/a2a/bounded-exchange.js`, the D3 export/import
  surface, the package schema or format documents, the receipt plane,
  the writer/reader kernels, `audit-log`, `ingest`, `storage.js`
  lookups, the conformance pipeline, tracing, metrics, or logging
  semantics;
- a new top-level reason namespace or a new receipt field;
- a linkage storage, registry, or fetcher;
- any claim that linkage implies trust — linkage references, it never
  endorses;
- cross-agent trust claims.

## 4. Acceptance preview (binding only in the implementation unit)

1. The module is pure: same inputs, same outputs, no side effects, no
   environment reads.
2. For each of the six namespaces, the round-trip test recomputes the
   decision from receipt-plus-evidence and matches reason verbatim;
   each of the five linkage failure modes fails linkage with a
   namespace-bearing reason, never a generic denial.
3. The compatibility assertion names which surfaces already satisfy
   the property (bounded-exchange as-is) and which remain
   `NOT_YET_LINKED`, with no ledger graduation.
4. File-size, cycle, status-declaration, and acyclicity checks stay
   green; touched files stay within their ratchet limits; tarball smoke
   tests (`4C1`), module reachability, and the 4437-test suite stay
   green; no receipt format, schema, or conformance pipeline change
   occurs.

## 5. Invariants

1. Linkage is reproducibility, not correlation: a receipt reproduces
   its referenced decision under the same deterministic rules that
   produced it — otherwise it is not linked, it is adjacent.
2. The bounded vocabulary is the linkage's detection mechanism:
   because reasons cannot grow per failure site, a broken link is
   detectable, and a receipt carrying a generic denial is failing
   linkage by construction.
3. Linkage is directional and one-way (receipt → decision evidence);
   a decision may be referenced by many receipts, a receipt by one
   decision set, and nothing inverts this to create implicit trust.
4. One clock, one workspace primitive, one lifecycle vocabulary — the
   linkage reproduces the judgment under the same inputs Gates 3–5
   fixed; adding a second clock or identifier to the linkage is
   adding the ambiguity those gates removed.
5. Observability adds no new authority; evidence records decisions, it
   never changes them, and linkage never upgrades a decision it
   carries.

## 6. Non-claims

This record does not claim that any identity-plane decision is
currently linked to any receipt (runtime identity enforcement does not
exist, per the closeout audit); that linkage implies trust or
cross-agent verification; that this pack modifies the D3 format, the
route receipt shape, the package schema, or the conformance pipeline;
that the storage plane's retrieval mechanics are governed here; or
that a hook has been chosen — Gate 2 keeps that decision, and this
gate only supplies its fourth criterion's testable content.

## 7. Gate order

- [x] Gate 1 — identity enforcement threat model (`v5-p1a-identity-threat-model.md`)
- [ ] Gate 2 — runtime hook location and fail-closed behavior
- [x] Gate 3 — connector boundary policy (`v5-p1-gate3-connector-boundary-policy.md`)
- [x] Gate 4 — workspace binding and delegation policy (`v5-p1-gate4-workspace-delegation-policy.md`)
- [x] Gate 5 — revocation / expiry runtime behavior (`v5-p1-gate5-revocation-expiry-behavior.md`)
- [x] Gate 6 — Trust Receipt linkage requirements (this task pack, docs-only)
- [ ] Gate 7 — conformance fixtures for enforcement behavior
- [ ] Gate 8 — rollback and migration plan
