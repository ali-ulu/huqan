# V5 implementation entry successor audit

**Status:** `closeout`

This is the successor entry audit that ADR-010 requires. ADR-010 recorded
`V5_IMPLEMENTATION_ENTRY: FAIL` against an older snapshot and stated that later
source changes do not silently turn that `FAIL` into a `PASS`. This document
runs the Re-entry Rule against current `main` and records the resulting verdict.

It changes no runtime code, no declaration, no test, and no reachability
classification. It produces a decision; acting on that decision is separately
scoped work.

## Audited base

```text
repository: ali-ulu/huqan
branch: main
exact source: b6ea911ef44ad9a762ad2a1b57a85a64281a580c
package: 0.9.1
```

ADR-010 forbids reusing its own snapshot rows as current evidence, so every row
below was re-established against the SHA above rather than copied from the
older audit.

## The rule being applied

`docs/adr/ADR-010-v5-ecosystem-entry.md` ("Re-entry Rule") permits a successor
audit to record `PASS` only after live source proves both:

1. `V4-B5` final closeout is closed with source, targeted test, full-suite,
   hardened CI, package/release smoke, limitations and canonical SHA evidence;
   and
2. the external interoperability/conformance entry dependency has a real
   external consumer/verifier smoke with fail-closed invalid/tampered cases.

Both conditions are evaluated below. Nothing else is treated as a condition,
and no additional condition is invented at this gate.

## Condition 1 — V4-B5 closeout

| Check | Observation | Class |
|---|---|---|
| Issue `#272` (`V4-B5`) | `closed` / `completed` | GÖZLENDİ |
| Closing PR | `#590`, `MERGED` | GÖZLENDİ |
| Recorded verdict | `V4_B5_SOURCE_TEST_CI_RELEASE_CLOSEOUT: PASS` | GÖZLENDİ |
| Evidence artifact | `docs/v4-b5-source-test-ci-release-closeout.md` present at the audited base | GÖZLENDİ |
| Roadmap row | `docs/current-operating-roadmap.md` records V4-B5 `PASS` | GÖZLENDİ |
| Acceptance boxes | All ten criteria checked on `#272`, including full suite, CI, and release smoke | GÖZLENDİ |

**Condition 1: SATISFIED.**

## Condition 2 — external consumer/verifier smoke

### Dependency issues

| Check | Observation | Class |
|---|---|---|
| Issue `#277` (`V5-C5`, external conformance runner) | `closed` / `completed`, closed by PR `#624` (`MERGED`) | GÖZLENDİ |
| Issue `#287` (`V5-D4`, runner passes) | `closed` / `completed`, closed by PR `#631` (`MERGED`) | GÖZLENDİ |
| Closeout artifact | `docs/v5/v5-d4-external-conformance-closeout.md` present | GÖZLENDİ |

ADR-010's Decision 3 row recorded this dependency as `FAIL` because "`#277`
remains open". That premise is no longer true at the audited base. This is the
single factual change that moves the entry decision.

### Is the consumer actually external?

The rule says "real external consumer". Verified in
`scripts/external-conformance/run.js` at the audited base:

| Property | Source evidence |
|---|---|
| Sandbox is outside the repository | `fs.mkdtempSync(os.tmpdir(), …)`, and the script *refuses to run* if the sandbox resolves inside `REPO_ROOT` |
| Consumer gets only the published artifact | `npm pack` tarball, installed into a throwaway project with no other dependency |
| Consumer is a separate process | `spawnSync(process.execPath, ['consumer.js'], { cwd: project })` |
| Consumer imports no repository internals | it resolves through the installed package root only |
| Package boundary is asserted | a case fails if `schemas/` leaks into the installed package |

This is a genuine out-of-repository installed-package consumer, not an
in-process unit test. **GÖZLENDİ.**

### Are invalid and tampered cases fail-closed?

Executed at the audited base:

```bash
npm run conformance:external -- --json
```

```text
total:        75
pass:         75
failed:        0
skipped:       0
blockedGaps:  []
crossImplementationExecuted: true
packageVersion: 0.9.1
```

Covered negative surfaces, per the case list and the D4 closeout: ATP negative
objects; malformed and tampered bundles; structural and semantic C3 negatives;
missing/expired/scope-exceeded and broken-delegation A2A evidence fixtures; and
a replay case where the installed authority accepts a signed package once and
then returns `EXTERNAL_CLIENT_AUTHORITY_REPLAY_DETECTED` for the identical
package. A mutation test bypasses duplicate reservation and requires the run to
fail, so the replay `PASS` cannot be decorative.

A shipped Python verifier is run against the same fixtures across legacy
ATP 0.1 and canonical HTP 0.2, and its findings must be byte-identical to the
JavaScript consumer's, including exit-status agreement.

**Condition 2: SATISFIED as written.**

## Verdict

Both Re-entry Rule conditions are satisfied against
`b6ea911ef44ad9a762ad2a1b57a85a64281a580c`:

```text
V5_IMPLEMENTATION_ENTRY: PASS
```

This supersedes the `FAIL` recorded in ADR-010 Decision 3, and only that. Every
other ADR-010 decision — the V4/V5 boundary, the artifact status vocabulary, the
ATP/HTP naming decision, and the marketplace deferral — is untouched.

## What this verdict authorizes

- Production wiring of the V5 modules currently held in
  `lib/module-reachability.js::NOT_YET_WIRED` under the reason "ADR-010 entry
  decision is FAIL", once that list is reconciled in its own scoped change.
- Entry into the gated V5 implementation track.

## What this verdict does not authorize or claim

The runner labels its own evidence honestly, and this audit does not inflate it.
Its report states: *"This run does not establish third-party verification or
interoperability."* Group evidence levels are `self-test` for objects,
fail-closed, bundles, replay and v5; `packaged-surface-smoke` for surface;
`installed-package-self-test` for package-wire; and
`cross-implementation-conformance` only for the Python comparison.

The Python verifier is shipped from this repository. Two implementations that
agree is stronger evidence than one, and it is still not an independent party.

Therefore this verdict does **not** claim:

- third-party or independently-developed verifier conformance;
- interoperability with any external product;
- production deployment, registry publication, or reachability of any
  V5 surface;
- that any A2A transport, Agent Card endpoint, discovery surface, or identity
  plane exists;
- Certified Node, TrustBench, public badge, marketplace, or reputation surfaces;
- connector-wide V5 enforcement;
- that `NOT_YET_WIRED` has been reconciled by this document.

An independent third-party consumer/verifier, separately deployed, remains
genuinely valuable and genuinely absent. It is now a **future gate on its own
merits, not a blocker on entry** — because the Re-entry Rule asks for a real
external consumer smoke, which exists, and does not ask for a third-party one.

## Evidence record

### GÖZLENDİ

- Audited base `b6ea911ef44ad9a762ad2a1b57a85a64281a580c`, package `0.9.1`.
- `#272` closed/completed via PR `#590`; `#277` closed/completed via PR `#624`;
  `#287` closed/completed via PR `#631`.
- `npm run conformance:external -- --json` → 75/75 pass, 0 failed, 0 skipped,
  `blockedGaps: []`, cross-implementation executed.
- Full suite at the audited base: `4249` tests, `4208` pass, `0` fail,
  `41` skipped.
- Out-of-repo sandbox, `npm pack` + tarball install, and separate-process
  consumer verified in `scripts/external-conformance/run.js`.
- `node scripts/check-doc-status.js` passes with this document present.

### TÜRETİLDİ

- ADR-010 Decision 3's external-conformance `FAIL` rested on `#277` being open;
  that premise no longer holds, so the row is re-derived rather than reversed by
  preference.
- Both Re-entry Rule conditions read literally are met, so withholding `PASS`
  would require inventing a third condition the rule does not contain.

### DOĞRULANMADI

- Third-party verifier conformance and external product interoperability.
- Any V5 production transport, deployment, or registry publication.
- Exact-head CI for this document's own commit, which attaches to the pull
  request rather than to this file.

Local full-suite evidence required an unshallow checkout: a shallow clone makes
`scripts/agent-context.js` report `CONTEXT_CONFLICT` and four
`test/agent-context.test.js` cases fail on ancestry that cannot be computed.
`git fetch --unshallow` resolves it. That is an environment condition, already
documented in `docs/refactor-technical-debt-research.md`, not repository debt,
and `docs/current-agent-checkpoint.json` is not stale.

## Next-agent envelope

```text
[BAĞLAM]
V5_IMPLEMENTATION_ENTRY: PASS recorded against
b6ea911ef44ad9a762ad2a1b57a85a64281a580c by this successor audit.

[GÖREV]
Reconcile lib/module-reachability.js: the thirteen V5 entries whose stated
reason is "ADR-010 entry decision is FAIL" now cite a superseded decision.
Reclassify only those, with the new reason, in one scoped change.

[KABUL]
No module becomes reachable by editing the list alone; reachability changes
only when a production caller is added under its own gate. Keep
test/module-reachability.test.js green and its stale-acknowledgement check
meaningful.

[YASAK]
Do not add an A2A transport, Agent Card endpoint, HTTP route, CLI command, or
MCP tool in that change. Do not touch entries outside the ADR-010 reason.
Do not claim third-party interoperability.

[SÜRÜM]
Base: b6ea911ef44ad9a762ad2a1b57a85a64281a580c
Artifact: docs/v5/v5-implementation-entry-successor-audit.md
```

## Two-minute eye test

```bash
npm run conformance:external -- --json | tail -5
node scripts/check-doc-status.js
git diff --check
```

Expected: a 75/75 report with `blockedGaps: []`, a passing status check, and no
whitespace error. If the conformance run is not green at the reviewed head, this
audit's Condition 2 does not hold and the verdict must not be cited.
