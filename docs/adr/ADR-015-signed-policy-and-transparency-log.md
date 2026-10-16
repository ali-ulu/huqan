# ADR-015 — Signed policy object, transparency-log requirement, and the trust/deployment boundary

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** repository owner
- **Supersedes:** —
- **Cross-references:** #3490, #3260, #3259, PR #3604, [ADR-008 trust-root boundaries](ADR-008-trust-root-boundaries.md), [ADR-012 audit evidence and admission](ADR-012-audit-evidence-and-admission.md)
- **Scope:** `lib/receipt/policy-seal.js`, `lib/receipt/issuer-seal.js`, `lib/issuer-seal-config.js`

## Context

K0 (#3470) gave policy objects an id, a semver version, a scope and a receipt,
and refused learned authority. Nothing bound those fields to a key. A policy
file copied between workspaces, or an old version re-presented as current,
passed every K0 check.

Issue #3490 (R35, class RESEARCH/REUSE) asked for a versioned and signed policy
object, bound the signature time to the evidence, decided the transparency-log
requirement, and drew the trust/deployment boundary. The measured starting
point was: `tlog` referenced 44 times, `verifyIssuerSeal` twice, while
`bundleDigest` and `logMask` were referenced zero times.

The implementation shipped in PR #3604. This ADR records the four decisions it
took so the issue can close with its open decisions stated rather than implied.

## Decision

### 1. Transparency log is required, fail-closed

A sealed policy names the transparency log that witnessed it
(`{ log, leafIndex, integratedAt }`). `verifySealedPolicy` requires that
evidence by default and returns `missing_transparency_evidence` when it is
absent. The only escape is the explicitly caller-owned
`allowMissingTransparency`, which is never a silent default.

There is no real Rekor client in this slice. The log reference is verified
**as shape**, not as a fetched inclusion proof. A deployment that presents a
log-shaped object is not thereby proven to be logged; it is only proven to have
said so. The real client is deferred to the follow-up issue.

### 2. The trust/deployment boundary passes through the verification point

Trust side (what a verifier decides):

- `verifyExportedBundle` — the exported receipt bundle;
- `verifyIssuerSeal` — the issuer signature over a receipt;
- `verifySealedPolicy` — the sealed policy object;
- `verifyMutationReceiptSealByOperation` — the mutation receipt seal, by
  operation.

Deployment side (how a key reaches the verifier):

- key distribution and the `lib/issuer-seal-config.js` line.

Key management is not folded into the trust decision. A verifier is handed a
public key; how that key was distributed is a deployment concern and stays out
of the verification result.

### 3. `bundleDigest` / signature-envelope v2 is deferred, with reason

The bundle hash envelope (#735, #767) already binds the receipt and the
envelope. Adding `exportedAt` / `schemaVersion` to the signature payload would
be a v2 envelope, and it would require changing the Python spec-verifier as
well. Cross-language agreement is the reason it is a separate slice, not a
detail to slip into this one. Deferred to the follow-up issue.

### 4. No new storage authority

The new code establishes no second signer, receipt family or durability
authority. Seal reading, bundle verification and redaction are reused as they
stand. This keeps a single receipt-verification authority.

## Consequences

- A sealed policy without transparency evidence is refused by default; the
  escape is a named, caller-owned flag.
- Verification results stay independent of how keys were distributed.
- The `tlog` requirement is real in shape and honest about its limit: shape
  verification is not inclusion-proof verification, and the follow-up issue
  carries the real client.
- The signature-envelope v2 change is a tracked follow-up, so a reader of the
  envelope is not told a field exists that does not.

## Evidence

- PR #3604, merged into `main` as `b8c8baa7`
  (`feat(security): seal read-side verification, signed policy, masking trace (#3490)`).
- `lib/receipt/policy-seal.js` — `sealPolicy` / `verifySealedPolicy`,
  `missing_transparency_evidence`, `allowMissingTransparency`.
- `lib/receipt/issuer-seal.js` — `verifyIssuerSeal`.
- `lib/issuer-seal-config.js` — the deployment-side key line.
- Tests: `test/policy-seal.test.js`, `test/mutation-receipt-seal-verify.test.js`,
  `test/logmask-erased-trace.test.js`.
