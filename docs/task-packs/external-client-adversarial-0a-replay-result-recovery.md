# EXTERNAL-CLIENT-ADVERSARIAL-0A - Replay Result Validation Recovery

## Plan Check

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact authorization base: `main @ 90a243edecb83f31573772f3c5ba18473a6a2536`
- Blocked predecessor: `EXTERNAL_CLIENT_ADVERSARIAL_0_IMPLEMENTATION`
- Blocker: `EXTERNAL_CLIENT_ADVERSARIAL_0_BLOCKED_BY_RUNTIME_CONTRACT_DEFECT`
- Mode: minimum runtime recovery plus adversarial regression tests
- This authorization document merges in a separate docs-only PR before the
  implementation base is sealed.

## Observed Defects

Independent source-real probes exposed two replay-result validation defects:

1. an own non-enumerable `reserved: true` data property is accepted as the
   exact success result even though canonical `{ reserved: true }` uses an
   enumerable property;
2. a hostile replay-result Proxy whose `getPrototypeOf` trap throws escapes as
   an untyped attacker error instead of the bounded
   `EXTERNAL_CLIENT_AUTHORITY_REPLAY_RESERVATION_FAILED` error.

The existing 30-test Authority/SDK baseline remains green. These defects are
outside the test-only Adversarial-0 scope and require a separately reviewed
runtime recovery before that gate can continue.

## Authorized Files for the Recovery Implementation

```text
lib/external-client-authority.js
lib/external-client-authority.test.js
```

No other file is authorized in the later implementation PR. This task-pack is
the sole file in the preceding docs-only authorization PR and is not counted
in the implementation diff.

## Required Runtime Correction

Apply the smallest correction that:

1. accepts canonical plain `{ reserved: true }` exactly as before;
2. requires the successful own `reserved` data property to be enumerable;
3. continues to reject extra string or symbol keys;
4. does not invoke accessor properties;
5. converts exceptions raised while classifying any replay-owner result into
   `EXTERNAL_CLIENT_AUTHORITY_REPLAY_RESERVATION_FAILED`;
6. preserves `false`, exact `{ reserved: false }` and existing-record evidence
   as `EXTERNAL_CLIENT_AUTHORITY_REPLAY_DETECTED`;
7. preserves reservation-before-handler ordering and all public result shapes.

Reuse the existing `plain`, `duplicate`, `exactReserved` and bounded `fail`
mechanisms. Do not add a general validator or new abstraction unless the
existing functions cannot express the correction safely.

## Required Tests

Extend the existing replay-result test owner to prove:

- non-enumerable own `reserved: true` fails with the exact reservation error;
- accessor-backed `reserved` fails without invoking the getter;
- symbol-extended and extra-field success shapes remain rejected;
- a Proxy throwing from `getPrototypeOf`, `ownKeys` or
  `getOwnPropertyDescriptor` produces the exact reservation error;
- no hostile-result case returns a successful authority decision;
- canonical `{ reserved: true }` still succeeds;
- existing duplicate evidence retains the replay-detected error.

Do not add a new test file or fixture.

## Required Evidence

```powershell
node --test lib/external-client-authority.test.js

node --test `
  lib/external-client-authority.test.js `
  lib/external-client-package-gate.test.js `
  lib/sdk-external-package.test.js `
  lib/external-client-endpoint-contract.test.js

git diff --check
git diff --name-only <authorized-base>..HEAD
git status --short
```

Existing repository-required Security Checks and classified CI must pass on
the exact reviewed head. Run no unrelated benchmark or Docker work locally.

## Stop Conditions

Stop if recovery requires:

- `lib/sdk.js`, SDK tests, server, Kernel, Graph, storage or receipt changes;
- a new error code, public API, dependency, schema or configuration key;
- changing duplicate-result semantics;
- a route, concrete replay store, mutation path or production writer;
- a third file or broad refactor.

## Definition of Done

Recovery closes only when the two defects have exact regression tests, the
two-file maximum implementation scope is preserved, targeted and related tests pass, exact
head CI and independent review are green, and exact-head merge plus clean
post-merge smoke complete.

After closeout, Adversarial-0 resumes from the new canonical main. Its remaining
test matrix is not automatically weakened or expanded by this recovery.

## Non-Claims

This recovery does not implement a reachable endpoint, HTTP identity,
concrete durable replay storage, mutation, receipt writing, external
interoperability, V4/V5 completion, release or deployment.
