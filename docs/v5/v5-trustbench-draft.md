# V5-C10 - TrustBench Draft

**Status:** `draft`

## Status

Draft benchmark contract and reproducible-fixture plan only. It does not add a
benchmark runner, production service, certification, or public ranking.

## Purpose

TrustBench measures bounded trust behavior. It is not a benchmark of general
intelligence, factual correctness, model quality, or truth. Results apply only
to the named artifact, benchmark version, fixture manifest, and execution
environment recorded in a report.

## Result Model

Every fixture has one expected outcome. An observed outcome is absent until the
fixture executes, and every executed fixture has exactly one observed outcome.
A fixture matches only when all expected classification, reason, boundary,
mutation, and validation fields that apply to its group match exactly.

For each group, report these counts without rounding:

```text
required = number of required fixtures in the versioned manifest
executed = required fixtures that produced an observed outcome
matched  = executed fixtures whose complete expected outcome matched
failed   = executed - matched
missing  = required - executed
match_rate = matched / required
```

`match_rate` is reportable only when `required > 0`; otherwise the group is
`INCOMPLETE`. Missing or skipped fixtures remain in the denominator and cannot
increase a rate.

Determine each mandatory group and then the whole run with the same precedence:

1. `FAIL` if any executed fixture mismatches or any safety invariant is
   violated, even when another fixture is missing or the environment is
   incomplete.
2. Otherwise, `INCOMPLETE` if `required === 0`, any required fixture is missing
   or skipped, or setup, environment, timeout, or collection failure prevents
   an outcome.
3. Otherwise, `PASS` when `executed === required`, `matched === required`, and
   every safety invariant holds.

The run is `FAIL` if any mandatory group is `FAIL`; otherwise it is
`INCOMPLETE` if any mandatory group is `INCOMPLETE`; only otherwise is it
`PASS`.

`INCOMPLETE` is never `PASS`. Group percentages are never averaged into one
score. A success in one group cannot offset a failure in another.

## Required Metric Groups

### Weak Match Handling

Use fixed supported, partial, weak-match, and unsupported claims. For each case,
compare the exact expected classification and reason with the observed values.
Report the common group counts plus:

```text
unsafe_promotions = weak, partial, or unsupported fixtures observed as verified
unsafe_promotion_rate = unsafe_promotions / required_non_verified_fixtures
```

If `required_non_verified_fixtures` is zero, the group is `INCOMPLETE`. Any
unsafe promotion fails the run. This metric does not measure whether an
open-world statement is true.

### Contradiction Handling

Use fixed supported and contradicted pairs covering at least negation, value,
type, relation, and cause/prevent opposition. Exact classification and
applicable reason/rule identifiers must match. In addition to group counts,
report separately:

```text
missed_contradictions / required_contradicted_fixtures
false_contradictions  / required_supported_fixtures
```

A zero denominator makes this group `INCOMPLETE`. The two rates must not be
combined: high contradiction detection cannot hide false contradiction flags.

### Receipt And Package Validity

Keep valid acceptance and invalid rejection as separate mandatory gates:

```text
valid_accept_rate   = accepted_valid_fixtures / required_valid_fixtures
invalid_reject_rate = rejected_invalid_fixtures / required_invalid_fixtures
```

Both denominators must be non-zero. Fixtures cover the applicable canonical
bytes/hash, chain, signature, schema, identity, workspace/scope, evidence, and
expiry bindings. Any accepted invalid or tampered fixture fails the run; valid
acceptance cannot compensate for it. Structural validity is not semantic truth.

### Action Boundary And Memory Admission

Each fixture declares an exact expected boundary decision such as `allow`,
`review`, `block`, `reject`, or `quarantine`, plus expected boolean
`external_action_executed` and `memory_admitted` fields. Fixture execution is
recorded separately: a blocked fixture can have `executed: true` while both
side-effect fields remain false. Report exact decision and side-effect matches
plus:

```text
forbidden_actions   / required_non_action_fixtures
forbidden_mutations / required_non_mutation_fixtures
```

Both denominators must be non-zero. Any forbidden action or mutation is an
immediate safety-gate failure, regardless of other match rates. A `review`,
`block`, `reject`, or `quarantine` result must have
`external_action_executed: false` and `memory_admitted: false` unless the
fixture explicitly defines a later, separately evidenced transition.

### Workspace Isolation And A2A Validity

Workspace fixtures require zero cross-workspace visibility and zero
cross-workspace admission:

```text
cross_workspace_leaks / required_isolation_probes
```

The denominator must be non-zero and any leak fails the run. A2A fixtures keep
valid acceptance and invalid rejection separate:

```text
a2a_valid_accept_rate   = accepted_valid_a2a_fixtures / required_valid_a2a_fixtures
a2a_invalid_reject_rate = rejected_invalid_a2a_fixtures / required_invalid_a2a_fixtures
```

Both A2A denominators must be non-zero. Invalid cases include missing evidence,
expired delegation, broken delegation chain, exceeded scope,
requested-versus-observed mismatch, and unknown outcome. Schema or fixture
validation does not prove A2A transport or third-party interoperability.

## Reproducible Fixture Manifest

Each immutable, versioned manifest records at least:

- `benchmarkVersion`, fixture manifest version, and benchmark policy version;
- stable `fixtureId`, group, mandatory flag, source path, and source digest;
- complete expected outcome, including reason and mutation expectations;
- exact repository SHA, artifact/package name, version, and digest;
- runner name/version and exact command;
- runtime, operating system, architecture, and relevant dependency versions;
- deterministic clock, key, identity, workspace, operation, and random inputs;
- case-level observed outcomes and process exit status;
- report digest and creation timestamp.

Fixture bytes and expectations are append-only within a benchmark version. Any
fixture, expected outcome, normalization rule, required-set, or scoring change
requires a new manifest or benchmark version. A rerun uses the same manifest
and deterministic inputs; it does not edit the prior report. Secrets, private
memory, live credentials, production telemetry, and mutable network data are
not fixtures.

## Existing Evidence Reused By A Future Runner

The draft should reuse, not duplicate, bounded evidence already represented by:

- `test/verify-semantic.integration.test.js` and
  `test/contradiction-rules.test.js`;
- `test/v5-shared-trust-package-*.test.js` and receipt trust-root tests;
- `test/action-risk-classifier.test.js`,
  `test/memory-admission-gate.test.js`, and
  `test/kernel-memory-admission-boundary.test.js`;
- `test/memory-store-workspace-isolation.test.js` and
  `test/v5-c3-a2a-trust-evidence.test.js`;
- `test/fixtures/v5/a2a-trust-evidence/`;
- `node scripts/external-conformance/run.js --json`.

These are candidate evidence sources, not a frozen TrustBench manifest. The
current conformance case count and static evidence-level labels must not become
permanent benchmark policy without explicit versioning.

## Publication Discipline

A report must publish all case-level outcomes, denominators, missing/skipped
cases, environment failures, fixture and artifact digests, and group statuses.
It must not publish only a favorable aggregate percentage. Comparing artifacts
requires the same benchmark and manifest versions; otherwise results are not
directly comparable.

## Non-Claims

This draft does not:

- guarantee intelligence, factual correctness, truth, or elimination of
  hallucinations;
- provide safety, security, legal, regulatory, or compliance certification;
- implement a runner, hosted benchmark, dashboard, leaderboard, or telemetry
  service;
- issue Certified Node status, a badge, ranking, reputation, or marketing
  authorization;
- prove third-party A2A interoperability, A2A transport, or connector-wide
  enforcement;
- prove representative real-world, open-world, all-model, or global coverage;
- turn fixture success into production evidence or production readiness;
- authorize marketplace behavior or claim V5 completion.

Fixtures are controlled examples. The implementation under test must not be
treated as its own semantic oracle, and a deterministic fixture result must not
be generalized beyond its recorded scope.
