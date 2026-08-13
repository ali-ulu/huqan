# GITHUB-APP-TRUST-LOOP-1 — Computed Review Verdict Projection

## Goal

Replace the GitHub App beta handler's receipt-level hardcoded canonical verdict with a bounded source-decision → canonical-verdict projection, without turning C7 into PR code-risk analysis or Streaming Trust.

The approved C7 product meaning is narrow:

> A genuine, accepted GitHub `pull_request` delivery that has passed the existing HMAC, event/action scope, immutable repository/install/PR/head binding, payload validation, and durable delivery reservation is an observation that **requires review**. C7 does not decide that the PR code is safe and must never emit `allow` from this gate.

This decision was recorded on issue #279 before this task pack.

## Branch

Implementation branch:

```text
productization/c7-github-app-verdict-projection
```

## Base commit

Authorization base:

```text
f237f606bdc2399f2659b336d65861ff9a328f88
```

Implementation must start from current live `main`. If `main` moved, record the new exact base and re-read the four allowed files before editing. Do not reset live source to this historical SHA.

## Failing evidence

Current source in `lib/github-app-beta-handler.js` passes a literal canonical verdict directly into `buildCanonicalReceiptPayload()`:

```js
{ verdict: 'review' }
```

The handler also writes `decision: 'beta_observation_only'` directly. The C7 test asserts those literals, so it proves the receipt shape but does not prove that the canonical verdict is derived through HUQAN's verdict reconciliation owner.

## Allowed files

Implementation may change only:

```text
lib/verdict/action-verdict.js
lib/github-app-beta-handler.js
test/v4-verdict-reconciliation.test.js
test/v5-c7-github-app-beta.test.js
```

## Forbidden files

Do not modify:

```text
github-app-server.js
lib/github-app-beta-http-boundary.js
lib/github-app-beta-auth.js
lib/github-app-beta-store.js
lib/github-app-writeback-contract.js
lib/v5/**
server.js
kernel.js
graph.js
package.json
package-lock.json
schemas/**
docs/current-agent-checkpoint.json
docs/current-operating-roadmap.md
```

## Negative scope

This gate must not:

- inspect PR title/body/diff or persist raw PR content;
- perform risky-change detection or code-safety verification;
- emit `allow` for a GitHub PR;
- add GitHub check-run/comment write-back;
- call `createInstallationAccessToken()`;
- add an outbound network call;
- publish or sign a public trust receipt;
- wire any `lib/v5/*` module into a production entry point;
- change webhook HMAC, payload-size, event/action, replay/idempotency, receipt-chain, store, HTTP status, or secret behavior;
- add dependencies, package surface, routes, CLI/MCP tools, or configuration.

Those are separate successor gates. Risky-change/event-to-verdict-to-review-gate behavior belongs to #280 (V5-C8), not this C7 increment.

## Required implementation contract

1. `lib/verdict/action-verdict.js` remains the single canonical verdict projection owner.
2. Add one bounded GitHub App beta source-decision mapping. The only authorized C7 source decision is:

```text
beta_observation_only -> review
```

3. Unknown GitHub App beta source decisions must fail closed through the existing `UnknownVerdictSourceError`; they must never default to `allow`.
4. `lib/github-app-beta-handler.js` must derive the canonical verdict through that mapping after the delivery has passed the existing validation/binding/reservation path.
5. The receipt remains semantically identical for a valid C7 delivery:

```text
decision = beta_observation_only
verdict  = review
status   = observed
approvalStatus = pending
```

6. Duplicate/redelivery behavior remains exact: an already completed identical delivery returns the stored receipt and does not derive or persist a second receipt.
7. This change must not create a second verdict vocabulary or add a new canonical verdict value.

## Acceptance criteria

- [ ] Canonical verdict set remains exactly `allow`, `review`, `block`, `dry_run_only`, `quarantine`, `disabled`.
- [ ] GitHub App beta mapping is explicit and maps only `beta_observation_only` to `review`.
- [ ] Unknown GitHub App beta source decision throws `UnknownVerdictSourceError`.
- [ ] Handler no longer contains a receipt-construction literal `{ verdict: 'review' }`.
- [ ] Valid signed/scoped/bound delivery still emits receipt `decision=beta_observation_only`, `verdict=review`.
- [ ] No valid C7 path emits `allow`.
- [ ] Existing immutable source binding and private-data non-persistence assertions remain green.
- [ ] Existing replay, duplicate, crash-window, invalid header/event/action/UTF-8/signature fail-closed tests remain green.
- [ ] No production write-back, public-receipt publication, network mutation, package or route change.

## Falsification tests

Tests must attempt to disprove the claim, not merely assert the happy-path literal:

1. Call the GitHub App beta source mapping directly with `beta_observation_only` and prove it resolves to canonical `review`.
2. Call it with an attacker/unknown source decision and prove it throws rather than returning `allow` or `review` by fallback.
3. In the C7 handler test, assert the result remains `review` while also asserting the handler source no longer passes a literal receipt verdict to `buildCanonicalReceiptPayload()`.
4. Preserve the existing invalid-delivery tests proving no receipt persistence before the accepted observation state is reached.

## Targeted tests

Required:

```bash
node --test test/v4-verdict-reconciliation.test.js test/v5-c7-github-app-beta.test.js
```

Also run the GitHub App HTTP/auth/store targeted suites if available in the current tree because the handler is inside that boundary.

## Full test requirement

Before merge recommendation:

```bash
npm test
```

Exact-head GitHub CI must be green on all required Node/security/architecture legs. Connector-only execution may mark local worktree/bootstrap/Graphify as `DOĞRULANMADI`; it may not invent results.

## Expected diff

Implementation expectation:

- 2 runtime files;
- 2 test files;
- no docs/package/server/V5 files;
- preferably < 100 changed lines total.

If the implementation requires a fifth file or materially wider diff, stop for scope expansion.

## Stop conditions

Stop and report `BLOCKED` if any of these becomes necessary:

- defining what makes PR code itself safe/unsafe;
- reading PR title/body/diff for verdict computation;
- adding a new canonical verdict;
- wiring `lib/v5/*`;
- GitHub write-back or installation-token production wiring;
- route/server/package/dependency changes;
- weakening any fail-closed validation or replay behavior;
- changing receipt schema/wire semantics beyond deriving the existing `review` value through the canonical owner.

## Trust / provenance / gate impact

This increment changes **how the existing C7 `review` verdict is derived**, not what C7 authorizes. Immutable GitHub delivery provenance/binding stays authoritative. The gate remains observation-only and human-review requiring. It does not certify PR code, produce an `allow`, or establish Streaming Trust.

## Final report format

```text
BRANCH:
BASE HEAD:
HEAD COMMIT:
CHANGED FILES:
TARGETED TESTS:
FULL TESTS:
CI:
ARTIFACTS:
DIRTY ROOT:
SCOPE:
TRUST / PROVENANCE / GATE IMPACT:
KNOWN GAPS:
VERDICT:
NEXT STEP:
READY_FOR_REVIEW:
```

Allowed final verdicts: `READY_FOR_REVIEW`, `BLOCKED`, `NEEDS_FIX`, `DO_NOT_MERGE`.

No merge or C7 closure claim is authorized by this task pack alone. #279 still requires the separate real GitHub App installation/auth lifecycle and hosted real-repository beta smoke evidence.