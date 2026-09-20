# ADR-013 — Kernel ↔ KernelV2 substitutability contract

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** repository owner
- **Supersedes:** —
- **Cross-references:** #2117, #2115, #1171, #1989, #1619, [architecture policy](../architecture-policy.md)
- **Scope:** `kernel.v2.js` `verify`, `learnFromLLM`, and the `Kernel` instance it wraps

## Context

`KernelV2` holds a `Kernel` and post-processes what it returns. For some inputs
the two answered differently, and several of those differences existed only
because of call order: nothing stated them, and nothing named them in a test.
A caller holding one object could not know what held for the other.

The differences were enumerated and measured against `7ba1768f` (v1/v2 probe on
identical graphs, plus throw-mutants inside each suspect branch run against the
55 test files that reach `KernelV2`, 778 tests).

## Decision

A caller may assume the following for `verify`, whichever of the two it holds.

### What holds for both

1. The envelope shape: `ok`, `type: 'verify'`, `data.status` in
   `verified | contradicted | unknown`, `data.confidence`, `evidence[]`, `meta`.
2. A verdict `Kernel` produces is returned unchanged by `KernelV2`, except
   through one of the rules below.

### Where they legitimately differ

`KernelV2` may **add** fields: `data.evidenceSummary`, `data.explanation` and
manipulation-risk metadata (`_withVerifyDetails`). Adding a field never changes
`status`, `confidence` or `evidence`.

`KernelV2` may **substitute** a verdict only through a named rule. Each rule has
one producer and at least one test that exercises it.

| Rule | Producer | Verdict | Pinned by |
|---|---|---|---|
| Unresolved multi-word subject | the multi-word guard in `KernelV2.verify`, with `contradictedBaseVerdict` | `unknown`, `subjectResolution: 'exact_match_required'`; a `contradicted` verdict v1 already found is kept | `kernel.v2.test.js` (#1171), `test/issue-1989-turkish-type-negation.test.js` (guard exemption) |
| Negated statement vs known fact edge | `buildNegationConflict(…, { factsOnly: true })`, applied before v1 is consulted | `contradicted`, `contradictionReason: 'negated_statement_conflicts_with_known_fact'`, direct-edge evidence | `test/kernelv2-negation-conflict-families.test.js` |
| Negated statement vs known type edge, type chain, opposite predicate, type lattice | `buildNegationConflict` and `_buildContradictionDetails` | `contradicted` with the named `contradictionReason` | `test/kernelv2-negation-conflict-families.test.js`, `test/issue-1989-turkish-type-negation.test.js` |
| Negative claim v1 verified | `resolveNegativeClaimFallback` | `unknown`, `negativeClaimGuard: 'fail_closed'` | `test/kernel-v2-native-public-verify-result.test.js` |

The fact-negation verdict used to be written twice — once inline in
`kernel.v2.js`, once in `buildNegationConflict` — with identical fields. It now
has one producer.


### LLM-learning risk policy

`Kernel.learnFromLLM` remains the single owner of sentence conflict checks,
admission, provenance and canonical learning. `KernelV2` adds one named
pre-policy for manipulation risk before delegating to that owner.

The policy lives in
`lib/text-safety-scorer.js#prepareRiskAwareLearnFromLLM`, not in a second
sentence-processing loop in `KernelV2`:

- the default block threshold is `0.7`;
- the default downgrade threshold is `0.35`;
- a block-eligible sentence is removed unless `allowRiskyLearning === true`;
- when risky learning is explicitly allowed, that sentence is retained and
  recorded as `downgrade`;
- blocked sentences are added to the returned `skipped` count;
- risk details are attached after the wrapped Kernel completes its normal
  conflict/admission path.

This is a named V2 rule, not a second learning authority. The existing
`kernel.v2.test.js` block test and
`test/kernel-learn-from-llm-delegation-contract.test.js` pin the behavior and
the single-owner structure.

### Removed

A branch that turned a v1 `contradicted` into `unknown` when every semantic
signal was a type-relation `PREDICATE_DRIFT` (added in `ffe34cd4`). It could not
be reached: since #1619 (`876c6acf`) `buildVerifySemanticTrust` routes
`PREDICATE_DRIFT` as a risk, and a `contradicted` status always carries at least
one non-drift signal. A throw placed in the branch was hit zero times. The
invariant that makes it unreachable is now pinned by
`test/verify-semantic-trust-contradicted-invariant.test.js`.

## Consequences

- A new difference between the two layers is a new row in the table, with its
  producer and its test, or it is a defect.
- `learnFromLLM` no longer owns a duplicate sentence/risk loop in `KernelV2`; V2-specific manipulation filtering is a named pre-policy in `lib/text-safety-scorer.js`, while the wrapped Kernel remains the conflict/admission owner.
