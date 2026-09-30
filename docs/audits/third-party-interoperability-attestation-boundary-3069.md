# Third-Party Interoperability and Attestation Boundary — #3069

**Verdict:** `SELF_RUN_ONLY__TWO_CELLS_BLOCKED`

**Canonical base:** `main @ a52d955270436932367dfc6e68e88d6f4442e740`

**Evidence rule:** every count, file path and field name below is quoted from
this tree at that base. Two cells cannot be PASS and are recorded as *blocked*
with their reopen condition, never as PASS by inference.

## 1. What the issue asked

Issue `#3069` recorded that the conformance suites are repository-run checks
rather than third-party interoperability proof, and proposed three units:

1. evidence that at least one external organization independently verified a
   conformance bundle (a signed report);
2. an independent-verification attestation bound into the Trust Receipt bundle;
3. the self-run versus third-party distinction kept in the README Limits for
   enterprise readers.

Unit 3 is a documentation change and is delivered by this PR. Units 1 and 2 are
**not** repository work and are recorded here as blocked, because their
precondition is a party outside this repository — a claim this repository cannot
manufacture for itself.

## 2. Observed at this base (GOZLENDI)

1. **The suites run in this repository, on this repository's artifacts.**
   `scripts/external-conformance/run.js` and `scripts/a2a-conformance/run.js`
   are invoked by `npm run conformance:external` and `npm run conformance:a2a`
   from the same checkout that produces the artifacts they check. Same author,
   same repository.

2. **Live counts at this base.**

   ```text
   npm run conformance:external -- --json
     total 75, passed 75, failed 0, blockedGaps []
     evidenceLevels.cross-implementation: "cross-implementation-conformance"

   npm run conformance:a2a -- --json
     caseCount 54, passed 54, failed 0
     verdict V5_D6_BOUNDED_A2A_EXCHANGE_SUFFICIENT
   ```

   The external report's own `evidenceLevelNote` and the A2A report's
   `nonClaims` (`production_transport_not_implemented`) already state that this
   is not third-party evidence.

3. **The bundle signature exists in the producer.** `lib/receipt/signed-bundle.js`
   (`signReceiptBundle` / `verifyReceiptBundleSignature`,
   `huqan.receipt-bundle-signature.v1`, Ed25519) is wired into the export path
   at `lib/receipt/receipt-export.js:91` and re-checked on import at
   `lib/receipt/receipt-export.js:140-151` (`signatureStatus`,
   `requireSignature`). It is documented in the legacy copy,
   `specs/axiom-trust-protocol/0.1/RECEIPT-BUNDLE.md` (`bundleSignature`,
   "Issuer signature").

4. **The published HTP 0.2 copy does not carry it.**
   `specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md` documents no
   `bundleSignature` field, and
   `specs/huqan-trust-protocol/0.2/conformance/verify_bundle.py` has no
   signature code (0 occurrences, against 29 in the ATP 0.1 verifier). The
   0.2 publication predates the signed-bundle change (`313d11c4`, 2026-08-11,
   versus `7cde7a70`, 2026-09-03).

5. **Where "third-party" would have to come from is already named.**
   `lib/receipt/issuer-seal.js` states its seal "proves origin and integrity,
   not operator honesty", and points at `lib/receipt/collector-seal.js` as the
   third-party rung — "and only when the collector runs somewhere the operator
   does not administer". `lib/receipt/collector-seal.js` repeats that boundary
   in its own header. No such collector is deployed by this repository.

6. **The upstream tracking issue is closed for the same reason.** `#849`
   ("External conformance — no independent verifier exists") is `closed /
   completed`; its closing note records that the remaining units are
   "external-organization work by construction", and that a repo-internal
   verifier "would be self-attestation by another name". Its invariant 1
   forbids a verifier that imports from this repository.

7. **The ecosystem claims audit already carries the same blocked cell.**
   `docs/v5/v5-ecosystem-claims-audit-closeout.md` row A3 is
   `PASS local / BLOCKED external`, with the reopen condition "an issue body or
   public record that names the external party and its verifier commit/URL".

8. **The distinction was already stated elsewhere, but not in the README.**
   `docs/competitive-positioning.md:22,52,62` and
   `docs/current-operating-roadmap.md:158-238` carry it explicitly. The README
   `## Limits` section named neither the suites nor their self-run status
   before this PR, which is what unit 3 closes.

## 3. Blocked cells and reopen conditions

| Cell | Blocked on | Reopen condition |
| --- | --- | --- |
| Independent external verification of a conformance bundle | A party outside this repository; invariant 1 of `#849` forbids a repo-internal verifier | A public record naming the external party and its verifier commit or URL (`#849`'s own reopen condition; ecosystem claims audit A3-external) |
| Independent-verification attestation bound into the Trust Receipt bundle | Two independent blockers: (a) the published HTP 0.2 bundle contract specifies no attestation or issuer-signature field, and adding one is a protocol-version decision under `specs/huqan-trust-protocol/0.2/README.md`, not a documentation edit; (b) an attestation signed with a key the audited host also holds proves nothing (`lib/receipt/issuer-seal.js`) | (a) a separately authorized protocol contract change; **and** (b) an attestation key held by a party other than the audited host, i.e. a deployed collector as `lib/receipt/collector-seal.js` defines it |

Neither cell may be closed by a change inside this repository. Writing verifier
or attestation code here would convert a blocked external cell into a
self-attestation, which is the failure both `#849` and the ecosystem claims
audit exist to prevent.

## 4. What this PR changes

- `README.md` `## Limits` gains one bullet: the suites are self-run, a green run
  is repository-owned evidence, no external organization has verified a bundle,
  and no third-party attestation is bound into a bundle yet — with a pointer to
  this record.
- `test/third-party-interoperability-boundary.test.js` pins that bullet against
  the live source (the suites really are repository-run; the producer really
  carries `bundleSignature`; the published 0.2 copy really does not), so the
  README cannot drift back into an interoperability claim and the two blocked
  cells cannot be quietly dropped.

No runtime, schema, spec or workflow change.

## 5. Non-claims

This record does not claim: third-party verification, external
interoperability, a deployed collector, a signed third-party report, HTP 0.2
attestation support, or that any of the blocked cells is scheduled. It records
what is measured, what is blocked, and the exact condition that reopens each
blocked cell.
