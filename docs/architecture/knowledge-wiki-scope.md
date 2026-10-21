# Knowledge Wiki — Scope Note and Fixture Contract (#4144)

**Status:** scope note and fixture contract only. No runtime code, no new store,
no behavior change, no release or package change.
**Owner:** #4144.
**Measured at:** `origin/main` @ `55cf7683`, 2026-10-21. Every path and function
named below was verified by reading the source at that commit, not by directory
name.

## 1. What this note is, and what it is not

Karpathy's LLM Wiki gist is a reference for a maintenance workflow on top of an
existing knowledge surface. It is **not** a reason to add a new memory store to
HUQAN. This note fixes the boundary for a derived, read-only knowledge view and
the fixtures that pin it, before any such view is built.

This note creates no runtime module. The first PR under #4144 is documentation
and fixtures only. A read-only lint prototype, any write path, and any
promotion of derived output are separate, later work with their own gates.

## 2. One authority (unchanged)

The existing surfaces stay the single authority. Nothing here becomes a second
source of truth:

| Concern | Authority (as it stands) |
|---|---|
| Provenance of a learned item | `lib/provenance-ingest.js` → `buildProvenance()` |
| Content drift of a source | `lib/content-hash.js` → `contentHash()` |
| Whether a write is admitted | `lib/memory-admission-gate.js` → `evaluateMemoryAdmission()` |
| Durable memory writes | `lib/memory-store-write-methods.js` (installed through `install()`) |
| Canonical record, candidate claims, conflict | `lib/provenance-query-trust-receipt.js` → `queryTrustGraph()`, `buildTrustReceipt()` |

Two accepted decisions already bind this boundary and are not reopened here:

- `docs/adr/0005-provenance-model.md`: every durable mutation carries
  provenance; missing provenance is handled by policy, never fabricated.
- `docs/adr/0006-memory-admission.md`: all production memory writes pass through
  `evaluateMemoryAdmission`, directly or through a documented adapter.

`docs/cognitive-architecture-plan.md` line 56 states the same principle for the
COG program: "Faz 1–3'te ikinci bir kalıcı biliş deposu yoktur." This note adds
no store, so it stays compatible with COG #4060 without joining its scope.

## 3. Derived view, not canonical knowledge

A "knowledge wiki" here means a **derived, read-only view**: an `index.md`, a
topic or entity summary, and linked pages produced from existing records. It is
a rendering of the authority, not an authority.

- A derived page never becomes canonical because it was written.
- No derived page is a write target. Removing the whole view loses no record.
- Where the view and the authority disagree, the authority wins.
- This is distinct from `docs/wiki/` (the human-facing mirror of the GitHub
  wiki). That is prose about the product; this is a generated view over records.

## 4. Source identity for every derived claim

Every derived claim links back to its source **and version**. A bare `sourceRef`
is not enough, because a location keeps resolving after the content behind it
changes:

- `sourceRef` — names the location.
- `sourceVersion` — names which revision was read.
- `contentHash` — sha256 of the exact text read at ingest.
- `contentHashVerified` — true only when the content was checked against the
  source through a channel separate from the record itself.

The hash is drift detection, and that is all it is. `lib/content-hash.js` says
so directly: the hash sits inside the record it describes, so an editor who
rewrites the content and recomputes the hash produces a record that agrees with
itself. A declared hash is therefore never presented as a verified hash, and a
present hash is never presented as proof that a record is tamper-evident.

A record whose provenance carries no `sourceVersion` is not given one. The view
omits it from derived claims and reports a `missing_provenance` finding, because
a version invented at read time would be indistinguishable from a version the
source actually supplied. The `missing-provenance` fixture pins the empty
`sourceVersion` and the non-authoritative finding for that case.

## 5. Conflict policy (no auto-reconcile, no auto-promote)

When a new source contradicts an existing claim:

- the system does **not** reconcile automatically;
- the system does **not** promote the new claim to canonical memory;
- it produces a candidate claim and a conflict finding;
- the existing admission and approval boundary keeps the last word.

This is the current behavior of `queryTrustGraph()`: it surfaces
`candidate_claims` and a conflict signal, and canonical status is derived by
`deriveTrustStatus`, not assumed from the arrival of a new source.

## 6. Lint is read-only

The lint surface reports, and only reports:

- source staleness (source changed since ingest);
- missing provenance or a missing backlink;
- an orphan derived page (no inbound link);
- a conflict between a candidate claim and a canonical one;
- a coverage gap (a source with no derived claim).

Lint performs **no** mutation of canonical memory, of the graph, or of policy.
The `lint-read-only` fixture declares the required expectation — a
`beforeStateDigest` and `stateChanged: false` — rather than proving it: this
slice runs no lint and compares no before/after state, and section 12 defers
that proof to the read-only prototype PR.

## 7. Determinism and idempotency

Given the same fixtures and the same source versions, ingest and lint produce
the same result on every run and across a restart. Re-ingesting identical
content produces no duplicate claim or page. If a chronological `log.md` is ever
wanted, it is append-only and never records a secret or personal data.

## 8. Fixture set (this PR)

`test/fixtures/knowledge-wiki/cases.json` holds seven cases, each naming the
condition, the inputs, and the expected finding. `test/fixtures/knowledge-wiki/expected.json`
holds the expected finding per case id, and `test/knowledge-wiki-fixtures.test.js`
asserts the two agree and that every case is one of the seven named conditions.

| Case id | Condition | Expected finding |
|---|---|---|
| `idempotent-reingest` | same content ingested twice | no duplicate claim/page |
| `source-drift` | content at the same `sourceRef` changed | `source_drift` |
| `conflict` | new source contradicts a canonical claim | `conflict`, no canonical promotion |
| `missing-provenance` | claim with no `sourceRef`/verified link | `missing_provenance`, not authoritative |
| `orphan-page` | derived page with no inbound link | `orphan_page` |
| `lint-read-only` | lint over a fixed state | `read_only`, before state equals after state |
| `restart-idempotency` | re-run after restart on same versions | identical result to the first run |

## 9. Exact writable scope (this PR)

Only these files are created or changed:

1. `docs/architecture/knowledge-wiki-scope.md`
2. `test/fixtures/knowledge-wiki/cases.json`
3. `test/fixtures/knowledge-wiki/expected.json`
4. `test/knowledge-wiki-fixtures.test.js`

## 10. Forbidden scope (this PR)

- any change under `lib/` or `scripts/`;
- any new persistent store, schema, or second canonical truth;
- any write path, admission bypass, or automatic reconciliation/promotion;
- any new dependency, package, workflow, deployment, or version change;
- any claim that a present hash makes a record tamper-evident;
- any claim that lint, ingest, or the view is production-ready.

## 11. Stop conditions

Stop and report a conflict if:

- current source and an existing test disagree;
- a green fixture contract would require a runtime change;
- a new store, schema, dependency, or public API is needed;
- the boundary above cannot be stated without contradicting an accepted ADR;
- describing the current behavior requires inventing behavior that does not
  exist in the cited modules.

## 12. Acceptance criteria (this PR)

- [x] A short contract/flow describing reliance on the existing MemoryStore,
      graph and receipt surfaces (sections 2–4).
- [x] No new persistent store and no second canonical truth (section 2–3).
- [x] The source/version/provenance link shape is defined (section 4).
- [x] Fixtures and expected findings for source drift, conflict, missing
      provenance and orphan (sections 6, 8).
- [ ] Lint read-only proven by test — deferred to the read-only prototype PR;
      this PR ships the fixture that will carry that proof (section 6, case
      `lint-read-only`).
- [x] No tamper-evidence claim from a present hash (section 4).
- [x] Automatic reconciliation, automatic promotion and canonical-memory
      mutation are out of this slice (sections 5, 10).
- [x] Compatibility with the existing architecture documented without entering
      COG #4060 scope (section 2).

## 13. Non-claims

This note does not claim that a knowledge wiki is built, measured, or
production-ready. It does not authorize a write path, a new store, a new public
API, or any behavior change. It does not prove lint read-only; it defines the
fixture that will.
