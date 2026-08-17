# V5 P1 Gate 2 — Runtime Hook Location and Fail-Closed Behavior

**Status:** `spec`

**Parent issue:** `#846` (P1, agent identity enforcement chain). Gate 2
of the eight gates named in
`docs/v5/v5-agent-identity-closeout-audit.md`.

**Child issue:** none assigned yet; this document is the task pack. The
selection unit — the PR that actually picks a surface and binds it —
is a separate, single-purpose PR and is **not** authorized here.

**Mode:** Docs-first task pack only. No implementation, no new tests,
no wiring, no selection. This document changes exactly one file.

**Canonical base:** `main @ 7dc84b4` (merge of PR `#900`). A successor
must re-verify its own exact SHA.

## 1. Source reality

### 1.1 What the threat model assigns to this gate

The threat model defers the choice explicitly and fixes the ground
rules instead:

> "Gate 2 covers runtime hook location. This document deliberately
> does not choose between MCP, CLI, HTTP workflow routes or the
> GitHub App. Choosing a surface before a caller's requirement
> selects it would repeat precisely the error P0 avoided when it
> deferred its framing decision."

It names five criteria so that the selection becomes **an evidence
comparison rather than an architectural preference**:

1. **Runs before the mutation.** A2A's reserve-before-effect ordering
   is the working example.
2. **Is the single entry point, and cannot be bypassed.** Measurable:
   a reachability proof that every mutation path on that surface
   passes through the point — `lib/module-reachability.js` can
   measure this.
3. **Can fail closed.** An unresolvable identity rejects; it never
   defaults.
4. **Produces Trust-Receipt-linkable evidence**, under the namespace
   rules. Gate 6 (`v5-p1-gate6-trust-receipt-linkage.md`) now carries
   the testable content of this criterion: reason verbatim, clock
   reproducibility, binding context, lifecycle state, directional
   integrity.
5. **Integrates without breaking the existing caller contract.**
   Measurable: that surface's existing tests pass unchanged.

The threat model's own words on criteria 2 and 5: they "carry
measurable tests because 'cannot be bypassed' and 'does not break
anything' are otherwise matters of opinion."

### 1.2 What the codebase can already measure

Three measurement mechanisms exist in live source and Gate 2 builds on
them rather than re-inventing them:

- **`lib/module-reachability.js`** performs static require-walk
  reachability analysis from entries, with `NOT_YET_WIRED` — the
  stale-acknowledgement ledger whose graduation "happens only as a
  consequence of a real caller being proven reached by tests" — plus
  `analyzeReachability`, `walkRequires`, `collectSourceFiles`,
  `isStandalone`, and `isDynamicEntry`. Its own rule: deleting a
  ledger line fails the check as a stale acknowledgement rather than
  graduating anything. This is the tool that makes criterion 2
  disprove a claimed "single entry point": if a mutation path exists
  that the reachability walk from the candidate hook does not cover,
  the candidate fails, full stop.
- **The fail-closed kernel discipline already exists.** The
  verification kernels (`runtime-writer`'s admission chain, the
  A2A exchange surface, the resolver's unknown/unavailable/malformed
  handling) each reject whole on unresolvable identity rather than
  default. Gate 2 does not need to invent fail-closed behavior; it
  needs to state that whichever surface is selected must carry this
  discipline as an observable property — the same way Gate 3 fixed
  event semantics that the writer kernel already performs.
- **The test suite is the criterion-5 oracle.** 4437 tests pass on
  `main`; "integrates without breaking the existing caller contract"
  means the candidate's wiring PR leaves the surface's existing tests
  passing unchanged, asserted in CI rather than asserted by
  description.

### 1.3 What the surfaces are, factually

The repo's identity-bearing surfaces, as live source shows:
`lib/http/agent-workflow-routes.js` and the `POST /api/v5/packages`
admission route (V5 candidate family — routed as of PR `#871`, and
routed is not enforced: the seam still performs no identity check);
`lib/mcp/read-workflow-tools.js` (read-only by name and design — no
write tools exist); `cli.js` (mutation commands exist but the
identity-binding surface is separate); `github-connector.js` (still
`NOT_YET_WIRED` — library-only, no production caller); and the GitHub
App, whose live installation, webhook redelivery, and token evidence
is tracked under `#279`/`#292` and whose streaming-trust opening was
tied to that live evidence. Gate 2's job is not to rank these by
opinion; it is to state what evidence each one would have to produce
against the five criteria.

### 1.4 What is still not allowed

The closeout audit's explicit non-claim stands: "Runtime identity
enforcement does not exist." No pack merged to date has changed that.
Gate 2 must keep the same discipline the P0 packs kept: it may define
*how a choice becomes provable*; it may not make the choice, and its
successor may not implement enforcement on any surface.

## 2. The decision

Gate 2 writes the **selection ground rules** — the evidence forms the
five criteria take, the fail-closed behavior contract, and the
selection unit's boundaries — without choosing a surface.

### 2.1 The criteria as evidence

Each criterion gets a fixed, disproveable evidence form:

| Criterion | Evidence form | Disproof |
| --- | --- | --- |
| 1. Before mutation | A named, observable point on the surface that is statically reached by every mutation command/route on that surface, in pre-effect order (the A2A reserve-before-effect pattern) | One mutation path reaching effect without passing the point |
| 2. Single entry point | `module-reachability.js` analysis rooted at the candidate, showing every mutation path covered; mutation surfaces outside the root are proven absent or separately admitted | Any mutation path uncovered by the walk |
| 3. Fail closed | The kernel's existing reject-whole behavior applied at the hook: malformed, unknown, unavailable identity each reject with a namespace-bearing reason (Gate 3/5 vocabularies), never a default-to-valid | One path defaulting to accept on unresolvable identity |
| 4. Linkage | The five Gate 6 properties hold on decisions emitted through the hook, verbatim | Any divergence under recomputation |
| 5. Non-breaking | The surface's existing test suite passes unchanged after wiring | Any regression |

Criteria 2 and 5 stay measurable by construction; criteria 1, 3, and
4 become measurable by inheriting existing, proven mechanics rather
than asserting behavior by description.

### 2.2 The fail-closed behavior contract

Fail-closed at the hook means three obligations, each already
observable in live source and none invented here:

1. **Reject whole on unresolvable identity** — malformed metadata,
   unknown identity source, unavailable resolver: each maps to a
   namespace-bearing reason (`identity.invalid_claim` family), never a
   generic denial and never acceptance. The resolver's existing
   `unknown`/`unavailable` handling and the writer kernel's
   admission-chain discipline are the as-is evidence.
2. **No silent downgrade** — a degraded evaluation (e.g., lifecycle
   state unresolvable per Gate 5) rejects the whole decision; it
   cannot collapse to "not revoked" or "no claim."
3. **Observability without authority** — the hook's evidence records
   (receipt plane, atomicity) log the rejection but change nothing;
   the decision happens exactly once, at the hook, before effect.

### 2.3 The selection unit's boundaries

The successor unit — the PR that selects — is a **single bounded PR**
whose authority is narrow:

- It must **pick one surface** and present the evidence table of
  §2.1 filled for that surface; it must show which criterion is met
  by existing mechanics (as-is evidence) and which by its own wiring.
- It may add **one fail-closed check point** on the chosen surface,
  consistent with the pre-mutation ordering of criterion 1; it may
  not touch the kernels beyond reading their verdict shape, and it
  may not change any receipt format (Gate 6's authority), any
  reason vocabulary (threat model's vocabulary rule), or any
  `NOT_YET_WIRED` line (the ledger graduates only by proven real
  caller).
- It must assert criterion 5 **in CI on the same PR** — the
  surface's existing tests passing unchanged, not a description.
- It may not claim enforcement: wiring a check point is not
  enforcement until the enforcement chain's other gates (1, 3–6) are
  wired and a consumer proves reached. The distinction PR `#871`
  recorded — routed is not enforced — applies to every surface,
  including any new one.

**Two deliberate non-decisions:**

- **Which surface** stays this unit's decision — Gate 2 defines what
  would have to be true of a choice, not the choice itself; the
  threat model's P0-deferrence reasoning is the reason.
- **The GitHub App's identity surface** keeps its own beta evidence
  track (`#279`/`#292`); a selection that involves it must inherit
  that evidence rather than re-authorize it.

## 3. What the implementation unit may do

**Allowed**, in exactly this order — a single bounded PR:

1. The selection document: one surface, one evidence table per
   §2.1, each row pointing at the file and test that carries the
   evidence.
2. One fail-closed check point on the chosen surface — read-only with
   respect to the kernels, producing the Gate 6 linkage evidence and
   rejecting whole under §2.2; unresolvable identity never defaults.
3. A reachability proof run (the analysis `module-reachability.js`
   already exposes) asserting every mutation path on the chosen
   surface passes the point.
4. A compatibility assertion: the surface's existing tests pass
   unchanged in CI; the ledger gains no `NOT_YET_WIRED` graduation.

**Forbidden:**

- any change to `module-reachability.js`'s `NOT_YET_WIRED`
  acknowledgements, the kernels, the receipt formats, the schema,
  the reason vocabulary, `audit-log`, `ingest`, `storage.js`
  lookups, or any other surface's mutation paths;
- a second entry point, or a check point that accepts by default;
- any enforcement claim — the PR wires the check point; enforcement
  follows a proven real caller;
- multi-surface selection — one surface, one PR; other surfaces
  remain separate units.

## 4. Acceptance preview (binding only in the implementation unit)

1. The evidence table has five rows, each row names a file and a test
   as its proof; no row is prose.
2. The fail-closed check point rejects malformed, unknown, and
   unavailable identity each with a namespace-bearing reason; no path
   accepts on unresolvable identity.
3. The reachability proof covers every mutation command/route on the
   chosen surface; the stale-acknowledgement check stays green.
4. The surface's existing test suite passes unchanged in CI.
5. File-size, cycle, status-declaration, and acyclicity checks stay
   green; touched files stay within their ratchet limits; tarball
   smoke tests (`4C1`), module reachability, and the 4437-test suite
   stay green; no receipt format, schema, or ledger change occurs.

## 5. Invariants

1. Selection is an evidence comparison, never a preference: the
   surface that cannot fill its table with files and tests is not
   selectable.
2. The hook is the single decision point before effect — adding a
   second is adding the bypass the threat model names, however
   convenient.
3. Fail-closed means reject whole with namespace-bearing evidence;
   any silent downgrade to acceptance is a bug, not a policy.
4. The reachability proof is mechanical — `module-reachability.js`
   output — and its negation is a disproof; the ledger's
   stale-acknowledgement rule protects it from opinion-based
   graduation.
5. Observability adds no authority: the evidence records the
   rejection; the kernel decides; the hook carries both.

## 6. Non-claims

This record does not claim that any runtime hook has been chosen (the
threat model's own non-claim); that any surface currently carries
identity enforcement; that this pack selects between MCP, CLI, HTTP
workflow routes, or the GitHub App; that wired means enforced (PR
`#871`'s distinction stands for all surfaces); that the GitHub App's
beta evidence is re-authorized here; or that the closeout audit's
"runtime identity enforcement does not exist" has changed.

## 7. Gate order

- [x] Gate 1 — identity enforcement threat model (`v5-p1a-identity-threat-model.md`)
- [x] Gate 2 — runtime hook location and fail-closed behavior (this task pack, docs-only)
- [x] Gate 3 — connector boundary policy (`v5-p1-gate3-connector-boundary-policy.md`)
- [x] Gate 4 — workspace binding and delegation policy (`v5-p1-gate4-workspace-delegation-policy.md`)
- [x] Gate 5 — revocation / expiry runtime behavior (`v5-p1-gate5-revocation-expiry-behavior.md`)
- [x] Gate 6 — Trust Receipt linkage requirements (`v5-p1-gate6-trust-receipt-linkage.md`)
- [ ] Gate 7 — conformance fixtures for enforcement behavior
- [ ] Gate 8 — rollback and migration plan
