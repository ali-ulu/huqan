# EXTERNAL-CLIENT-ADVERSARIAL-0 - Fail-Closed Boundary Test Authorization

## Plan Check

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact authorization base: `main @ 5e9773c97e2a2f075b277342f45e3e41a8f4ad80`
- Checkpoint gate: `EXTERNAL_CLIENT_ADVERSARIAL_0_AUTHORIZATION`
- Predecessors: Endpoint-0 and Authority-0 merge, smoke and checkpoint reconciliation
- Mode: test-only fail-closed boundary proof
- Runtime implementation: initially forbidden
- Reachable HTTP route: forbidden
- Production mutation or receipt writer: forbidden

## Source-Reality Finding

Authority-0 already has direct unit and SDK integration coverage for exact
identity, workspace, package, permission and trusted-key scope; signed-package
freshness; trusted-key validity; atomic replay reservation; immutable evidence;
and server isolation. Existing package-gate and Endpoint-0 tests separately
prove signature/scope rejection and default-closed route configuration.

Adversarial-0 must not rewrite those tests or create a second test owner. The
remaining evidence gap is cross-boundary falsification: rejected inputs must
not reach the replay owner or handler, exact time boundaries must remain
stable, concurrent duplicate evidence must admit at most once under the
existing atomic-owner contract, and hostile replay-owner results must fail
closed without enabling any production path.

Graphify artifacts are absent on this exact base. Live source, existing tests,
exact Git evidence and required CI therefore control this contract.

## Decision

Adversarial-0 begins as a test-only gate. It extends the two existing test
owners and changes no runtime code:

```text
lib/external-client-authority.test.js
lib/sdk-external-package.test.js
```

The implementation must reuse existing helpers and error vocabulary. A new
test file, fixture corpus, abstraction or dependency is not authorized.

If an authorized test exposes a real contract defect, do not patch runtime in
the test PR. Stop and open a separate exact-base recovery scope that names the
minimum runtime file and preserves the thin-orchestrator boundary.

## Required Adversarial Matrix

### Rejection side-effect isolation

Prove with explicit counters that each relevant rejection occurs before every
forbidden downstream effect:

| Rejection class | Replay reserve | Admission handler | Kernel fallback |
| --- | ---: | ---: | ---: |
| malformed or tampered package | 0 | 0 | 0 |
| identity subject or kind mismatch | 0 | 0 | 0 |
| workspace, package or key-scope mismatch | 0 | 0 | 0 |
| revoked, not-yet-valid or expired key | 0 | 0 | 0 |
| invalid, stale or future-dated signed `createdAt` | 0 | 0 | 0 |
| missing or malformed permission | 0 | 0 | 0 |
| duplicate replay evidence | existing atomic call only | 0 | 0 |
| replay-owner throw, rejection or malformed result | 1 | 0 | 0 |

Tests may combine equivalent rows when one assertion clearly proves all three
counters. Do not duplicate cases that already prove the exact same boundary.

### Exact time boundaries

Using the existing trusted clock and signed package builder, prove exact
inclusive/exclusive behavior for:

1. `createdAt == key.notBefore`;
2. `createdAt == key.notAfter`;
3. `now == key.notBefore`;
4. `now == key.notAfter`;
5. `now - createdAt == EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS`;
6. `createdAt - now == EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS`;
7. one millisecond beyond each allowed freshness boundary.

Tests must lock current source behavior. They must not invent a new interval
policy or caller-configurable time bound.

### Concurrent replay behavior

Run two concurrent admissions for identical signed evidence against one
controlled atomic replay owner. The owner may return exactly one
`{ reserved: true }` result and one duplicate result. Prove:

- exactly one handler invocation;
- exactly one allow result;
- exactly one `EXTERNAL_CLIENT_AUTHORITY_REPLAY_DETECTED` rejection;
- identical deterministic replay keys;
- no automatic retry or reservation release.

This proves only the existing atomic-owner interface. It does not implement or
claim a durable replay store, cross-process locking or distributed consensus.

### Hostile replay-owner results

Prove that inherited, accessor-backed, symbol-extended, extra-field and
otherwise non-exact reservation results cannot be interpreted as success.
Attacker-controlled getters must not be invoked. Failure must use the existing
bounded replay-reservation error and must not call the handler.

Also assert that the record passed to the replay owner is deeply frozen,
secret-free and limited to the existing Authority-0 evidence fields. Do not
add a new record field or change the production shape in this gate.

### Boundary isolation

Preserve and directly assert that the complete adversarial matrix does not:

- register or reach an HTTP route;
- infer authority from Endpoint-0 `requested` configuration;
- call Graph, Kernel, memory, approval, audit or receipt mutation;
- select a production V2 writer or trust-root owner;
- read authority from environment or global request state;
- change non-package SDK behavior.

## Authorized Files for the Test PR

```text
lib/external-client-authority.test.js
lib/sdk-external-package.test.js
```

Both files need not change if one existing owner can prove a case without
duplication. No third file is authorized.

## Required Refactor Discipline

- Reuse existing package, signing, authority and replay helpers.
- Do not add a generic adversarial framework or new abstraction.
- Do not move production logic merely to satisfy a test.
- Do not add domain logic to `lib/sdk.js` or any legacy orchestrator.
- If a later recovery is authorized, extract only the coherent failing
  responsibility and keep the SDK responsible for wiring and ordering.

## Required Evidence

The test PR must run:

```powershell
node --test `
  lib/external-client-authority.test.js `
  lib/sdk-external-package.test.js

node --test `
  lib/external-client-authority.test.js `
  lib/external-client-package-gate.test.js `
  lib/sdk-external-package.test.js `
  lib/external-client-endpoint-contract.test.js

git diff --check
git diff --name-only <authorized-base>..HEAD
git status --short
```

Expected changed files are a subset of the two authorized test files. Existing
repository-required Security Checks and change-classified CI must pass on the
exact reviewed head. Local full-suite, benchmark and Docker reruns are not
required for this test-only gate unless CI classification or a discovered
runtime defect makes them relevant.

## Stop Conditions

Stop with `EXTERNAL_CLIENT_ADVERSARIAL_0_BLOCKED_BY_RUNTIME_CONTRACT_DEFECT`
if a required test proves current runtime behavior violates this contract.

Stop and report rather than widening scope if the work requires:

- any production source change;
- a new test or fixture file;
- a new error code, public API, schema, dependency or configuration key;
- route registration, HTTP parsing or response serialization;
- concrete replay storage or persistence migration;
- Graph, Kernel, memory, approval, audit or receipt mutation;
- production V2 writer or trust-root ownership selection;
- historical receipt rewrite, backfill or rehash;
- release, deployment or package-version change;
- changing an exact time-boundary policy instead of documenting source reality.

## Definition of Done

Adversarial-0 closes only when:

1. exact-base authorization and implementation scopes merge separately;
2. the authorized test files prove the required matrix without duplicate test
   infrastructure;
3. no runtime file changes unless a separate recovery gate is reviewed and
   authorized;
4. targeted and related tests pass with exact counts and zero failures;
5. exact-head CI, independent read-only review and exact-scope checks pass;
6. exact-head merge, clean post-merge smoke and checkpoint reconciliation are
   green;
7. reconciliation opens only `EXTERNAL_CLIENT_ENABLEMENT_0_AUTHORIZATION`.

## Non-Claims

This task-pack does not claim or authorize:

- a reachable external-client endpoint;
- HTTP authentication or transport identity extraction;
- a concrete durable replay-store implementation;
- production mutation, approval, audit or receipt behavior;
- production V2 receipt writing or trust-root ownership;
- external interoperability or route enablement;
- V4 or V5 completion;
- release, deployment, package-version or dependency change.
