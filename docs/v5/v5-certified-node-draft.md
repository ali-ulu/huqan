# V5-C9 — Certified Node Criteria Draft

**Status:** `draft`

## Status

Draft criteria only. This document does not issue a certificate or badge and
does not authorize a public launch.

## Purpose

`Certified Node` is a future, time-bounded statement about a named node,
artifact, scope, and evidence snapshot. It is never a self-declared trust label.
Eligibility must be derived from reproducible conformance evidence.

## Current Evidence Boundary

The current evidence source is:

```text
node scripts/external-conformance/run.js --json
```

The runner currently emits fields including `packageRoot`, `packageVersion`,
`total`, `passed`, `skipped`, `failed`, `blockedGaps`,
`crossImplementationExecuted`, `evidenceLevels`, `evidenceLevelNote`,
individual `cases`, and `consumerProject` (always present, but `null` unless the
consumer project is kept). These are runner output fields. Exit code zero only
means there was no failed case; it may still accompany a skip and is not
eligibility evidence by itself.

The current runner does **not** emit a certification record, node identity,
workspace binding, issuance time, expiry time, revocation state, criteria
version, or evidence digest. Those are future issuer-owned envelope fields and
must not be inferred from a green run.

## Draft Eligibility Criteria

A future issuer may record `PASS` only when all of the following are true for
the exact artifact and scope being evaluated:

| Criterion | Current evidence mapping |
| --- | --- |
| Required conformance cases pass | Every policy-required entry in `cases` has `status: "pass"`. The current `ok` field is derived from that status and is not independent evidence. |
| No mandatory case is omitted | `failed === 0`, `skipped === 0`, and `passed === total`. |
| No declared implementation gap remains | `blockedGaps` is empty. The current runner emits this as a fixed empty list after replacing its known gaps; a later policy must not treat it as an independently discovered gap scan. |
| Required independent implementation comparison passed | The required `cross-implementation` case has `status: "pass"` and evidence level `cross-implementation-conformance`. The current `crossImplementationExecuted` flag is derived from that passing status; it does not independently distinguish “ran and failed” from “did not run.” |
| Evidence type is not overstated | `evidenceLevels` and `evidenceLevelNote` are retained with the result; the case-level `evidenceLevel` is a static group label and carries evidence only together with a passing status. `self-test` and `packaged-surface-smoke` are not relabeled as external interoperability. |
| Scope, evidence, and expiry fail closed | The policy-required `v5` cases covering missing scope, missing evidence, and missing or identity-governed expiry all pass. |

Any mandatory failure, skip, missing case, non-empty gap, evidence-level
mismatch, report tampering, or subject/artifact/scope mismatch makes the
candidate ineligible. A prior `PASS` cannot substitute for a current run.

The exact required case names and runner version must be frozen by a later
versioned certification policy. This draft does not silently treat the current
case set as a permanent certification standard.

The future eligibility decision has exactly `PASS` or `FAIL`: all criteria
above produce `PASS`; any ineligible condition produces a recorded `FAIL` with
a structured reason. Certificate lifecycle is separate: a passed record may be
`ACTIVE`, `EXPIRED`, or `REVOKED`. `EXPIRED` and `REVOKED` never convert the
historical eligibility decision and never permit an active certification
claim.

## Future Certification Record

A later issuer implementation would need an immutable record containing at
least:

- exact node/subject identity and workspace or tenant scope;
- exact artifact version and immutable source or package digest;
- certification policy and criteria version;
- runner version, command, immutable report reference, and report digest;
- evaluation and issuance timestamps;
- `expiresAt`, `PASS`/`FAIL` eligibility decision, lifecycle status, and
  structured reason;
- revocation timestamp and reason when revoked.

These fields describe a future record format. They are not current C5 runner
output and are not implemented by this document.

## Expiry And Revocation

Certification validity must end when `verificationTime >= expiresAt`; there is no
implicit grace period. Renewal requires a new conformance run and a new record.
Historical records remain append-only.

A future issuer must revoke or invalidate a record when its evidence is found
to be tampered, its node identity/artifact/scope binding no longer matches, the
underlying identity or key is revoked, a material security incident invalidates
the evidence, or the governing policy explicitly supersedes the result.
Revocation is not retroactive deletion and does not edit an old `PASS` into a
new result; it adds an auditable lifecycle event.

## Badge And Claim Rules

- A node, vendor, or operator cannot grant itself `Certified Node` status.
- A test screenshot, local green run, README badge, or marketing statement is
  not certification evidence.
- A future visual mark must resolve to the issuer-owned, scoped, unexpired,
  unrevoked record and must not imply broader trust than that record states.
- Marketing use and public launch require a separate reviewed gate.

## Non-Goals And Limitations

This draft does not:

- create, issue, sign, publish, verify, renew, expire, or revoke certificates;
- launch a badge or authorize marketing self-claims;
- prove third-party verification, interoperability, connector enforcement, or
  production readiness;
- create a marketplace, reputation system, ranking, payment, or trust economy;
- provide legal, regulatory, compliance, security, or universal trust
  certification;
- turn a package-level self-test into a global node identity claim;
- define a network revocation service or public certification authority.

The existing conformance runner remains group-scoped evidence. Public launch,
issuer governance, certificate format, key management, verification API,
monitoring, incident response, and revocation delivery each require later
implementation and review gates.
