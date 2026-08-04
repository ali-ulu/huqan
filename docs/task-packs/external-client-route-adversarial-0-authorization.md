# EXTERNAL-CLIENT-ROUTE-ADVERSARIAL-0 — Authorization

## Gate Identity

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact authorization base: `main @ 01e190b882a9dbf3daf306fd368b135ce83eec63`
- Checkpoint gate: `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_AUTHORIZATION`
- Governing sequence:
  `docs/task-packs/external-client-enablement-0-authorization.md`
- Closed predecessors: Identity/Trust Config-0, Durable Replay-0,
  Mutation/Receipt Owner-0 and HTTP Adapter-0
- Mode: docs-only authorization for a test-only local route integration proof
- Production route registration, `server.js` changes and deployment
  configuration: forbidden

The exact base is the PR #230 reconciliation merge and canonical `main`. This
document authorizes no runtime behavior. A successor starts from the exact
post-merge `main` and may change only the three test-owned files below.

## Source Reality

At the exact base:

1. `lib/external-client-endpoint-contract.js` reserves
   `POST /api/external-client/packages/admit`; both `disabled` and `requested`
   keep every route/authority/replay/mutation/writer readiness bit false.
2. `server.js` does not import the endpoint contract or HTTP adapter and does
   not register the path. The real server preserves generic `404`.
3. `server.js` applies `checkRateLimit()` before pathname dispatch and applies
   `requireApiKey()` inside authenticated route branches. Neither guard is
   external-client identity or authority.
4. `lib/external-client-trust-config.js` materializes one immutable server-owned
   profile from explicit input. No production profile loader exists.
5. `lib/external-client-replay-store.js` owns durable SQLite reservation from an
   explicit absolute path and supports close/reopen. No production replay-path
   source exists.
6. `lib/sdk.js` can pre-bind identity, workspace, package scope, permission,
   trusted keys, trusted clock, replay owner and package handler.
7. `lib/external-client-mutation-receipt-owner.js` owns the exact synchronous
   candidate quarantine and canonical V2 receipt through
   `Graph.runMutationOnce()`.
8. `lib/external-client-http-adapter.js` consumes one bounded
   `{ package, signature }` request and returns a frozen descriptor. It owns no
   socket, route, trust, replay, mutation or receipt semantics.
9. No production source composes these owners.
10. `package.json` uses `node --test`. Its current package surface already
    includes the existing package gate and Authority modules, but excludes the
    endpoint contract, trust materializer, replay owner, mutation owner and HTTP
    adapter. All authorized test files must remain excluded.
11. This task-pack path was absent before the authorization branch.

Graphify and clone bootstrap remain unavailable in the connector-only
environment because GitHub DNS cannot be resolved. Live source, exact Git
ancestry, tests and CI control this authorization.

## Decision

Route Adversarial-0 is an **evidence gate**, not production registration.

A test-local loopback harness will compose only existing owners:

```text
existing rate limiter
  -> existing API-key guard
  -> existing HTTP Adapter-0
  -> existing pre-bound SDK/Authority-0
  -> existing Durable Replay-0
  -> existing Mutation/Receipt Owner-0
  -> existing Graph SQLite journal and receipt
```

The harness may create an ephemeral loopback server and test-only Ed25519 keys.
It must close all servers, stores, graphs, timers and temporary files. It must
not expose a stable port, mutate the real server singleton, add production
configuration or claim production reachability.

The implementation is split by test responsibility. Each file remains at or
below 300 physical lines.

## Authorized Files and Ownership

```text
test/external-client-route-adversarial.test.js
test/helpers/external-client-route-harness.js
test/helpers/external-client-route-fixture.js
```

- The `.test.js` file registers tests and owns assertions only.
- `external-client-route-harness.js` owns loopback server/client, outer-guard
  ordering, adapter-to-socket mapping and network cleanup only.
- `external-client-route-fixture.js` owns generated keys/packages, temporary
  SQLite profile/replay/Graph composition, durable-state reads and cleanup only.

No other file is authorized. In particular, do not modify:

```text
server.js
requestGuards.js
lib/external-client-endpoint-contract.js
lib/external-client-http-adapter.js
lib/external-client-trust-config.js
lib/external-client-replay-store.js
lib/external-client-authority.js
lib/external-client-package-gate.js
lib/external-client-mutation-receipt-owner.js
lib/sdk.js
graph.js
kernel.js
storage.js
package.json
```

Test helpers may import production modules read-only. They may not monkey-patch
exports, mutate constants or create hidden mutable registries.

## Local HTTP Contract

The harness binds only to loopback on an operating-system-selected port and
uses a real Node HTTP client. The listener order is exact:

1. derive a unique bounded test-local quota key;
2. call existing `checkRateLimit()`;
3. reject quota failure before auth, body consumption, adapter, replay or
   mutation;
4. call existing `requireApiKey()` with an explicit test key;
5. reject auth failure before body consumption, adapter, replay or mutation;
6. call Adapter-0 only for the exact reserved path;
7. copy only the adapter status, headers and JSON body to the socket;
8. return generic test-local `404` for every other path.

API key and quota key never become identity, workspace, permission, trusted-key,
trust-root or replay authority. The harness removes only quota state it creates.

## Server-Owned Composition

The fixture materializes one profile with
`materializeExternalClientTrustConfig()` and binds outside request bytes:

```text
expectedIdentitySubject
expectedIdentityKind
expectedWorkspaceId
expectedPackageId
permissions
trustedKeys
trusted clock
replay store
graph-backed package admission handler
```

Request authority remains exactly `{ package, signature }`. The package handler
calls `commitExternalClientCandidateClaim()` exactly once with the existing
SDK-supplied Authority-0 context and never reconstructs authority from request
fields.

## Durable Evidence

Use one real temporary SQLite replay database and one real temporary SQLite
Graph database. JSON, process memory and best-effort substitutes do not qualify.

A valid first HTTP request proves:

- exact `201` and six-field Adapter-0 success body;
- one local pending/flag candidate;
- one completed mutation-journal result;
- one canonical V2 receipt with `trustRoot: external_verified_client`, review
  verdict/decision and pending status; and
- durable identifiers matching the response.

After closing and reopening the replay owner on the same database, identical
signed evidence is rejected before a second mutation, with unchanged candidate,
journal and receipt counts.

Authority replay and mutation-journal replay are separate claims. A separate
case may reuse an already authoritative context to call the mutation owner and
prove Adapter-0 `200` only when the journal result returns `replayed: true`; it
must not describe this as a second Authority admission.

Two concurrent identical HTTP requests produce exactly one successful
quarantine and one replay rejection, followed by exactly one candidate, one
completed journal result and one canonical receipt.

Positive durability/concurrency claims use real SQLite owners. Stubs are allowed
only for labeled negative malformed-dependency tests.

## Real-Server Absence

Load real `server.js` with auto-listen disabled, bind it to an ephemeral
loopback port and leave source unchanged. Under both endpoint configuration
states:

```text
disabled
requested
```

`POST /api/external-client/packages/admit` remains generic `404`. `requested`
does not import the adapter, create replay state, mutate Graph or make readiness
true. Close the HTTP listener and invoke existing narrow resource cleanup; do
not kill unrelated processes.

## Rejection Matrix

Prove zero new candidate, journal and receipt rows for:

- missing/wrong API key and quota exhaustion;
- wrong method;
- missing, duplicate, conflicting or expanded content type;
- malformed/conflicting content length and declared/observed overflow;
- empty body, malformed JSON and invalid UTF-8;
- primitive, array, unknown envelope and literal `__proto__`;
- depth `33` and aggregate value `10_001`;
- body-supplied identity, workspace, package scope, permission, key, trust root,
  clock, replay, handler or retry authority;
- malformed signature and invalid package semantics;
- stale, future-dated, revoked, unknown-key and wrong-scope signatures; and
- profile/package identity or workspace mismatch.

Failure bodies must not expose API keys, key material, signatures, package
bytes, profile data, replay keys, paths, internal codes/messages/details or
stacks.

## Unknown Outcomes

Cover separately:

1. handler rejection before mutation;
2. replay reservation failure or hostile result;
3. mutation owner `OUTCOME_UNKNOWN`;
4. mutable, partial or inconsistent dependency success; and
5. client disconnect, stream abort or timeout before delegation.

Each settles once, performs no retry, invokes no second handler/reservation and
leaks no internal evidence. Unknown mutation outcome maps to bounded `503`.
Do not claim rollback unless durable evidence proves it.

## Response Boundary

Successful socket responses match Adapter-0 exactly:

- `201` for new quarantine;
- `200` only for exact mutation-journal replay;
- `Content-Type: application/json; charset=utf-8`;
- `Cache-Control: no-store`; and
- exactly six approved body fields.

Failures use only the bounded outer-guard response or Adapter-0
`{ ok: false }` from the rejecting layer. No public error vocabulary is added.

## Required Test Groups

The assertion owner proves at least:

1. real server remains `404` under disabled/requested states;
2. quota then API-key guard precede adapter/body;
3. valid first request returns `201` and exact durable evidence;
4. concurrent duplicates yield one allow, one replay rejection and one durable
   outcome;
5. replay close/reopen rejects duplicate evidence without second mutation;
6. journal replay remains distinct and maps to exact `200`;
7. caller authority and malformed transport fail closed;
8. signature/key/freshness/package/scope failures create no rows;
9. handler/replay/unknown mutation failures never retry;
10. responses contain no secret or internal evidence;
11. resources close deterministically;
12. static source proof keeps real route and adapter import absent;
13. exact diff contains only three authorized files, each at most 300 lines;
14. `npm pack --dry-run` excludes all three test files plus the endpoint
    contract, trust materializer, replay owner, mutation owner and adapter while
    preserving the existing package surface rather than claiming Authority or
    package-gate removal; and
15. a real HTTP smoke matches response IDs to durable candidate/journal/receipt
    state.

## Required Validation

```bash
node --test test/external-client-route-adversarial.test.js
node --test \
  lib/external-client-endpoint-contract.test.js \
  lib/external-client-http-adapter.test.js \
  lib/external-client-package-gate.test.js \
  lib/external-client-authority.test.js \
  lib/sdk-external-package.test.js \
  lib/external-client-replay-store.test.js \
  lib/external-client-mutation-receipt-owner.test.js
npm test
npm pack --dry-run
git diff --check
git status --short
```

Static evidence:

```text
server.js lacks /api/external-client/packages/admit
server.js lacks external-client-http-adapter import
only the three authorized test files change
each authorized file is at most 300 physical lines
no runtime or package file changes
```

Report exact counts when available. Green CI without counts is a workflow
conclusion only.

## Stop Conditions

Stop with `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_BLOCKED_CONTRACT_CONFLICT` if the
proof requires:

- any file outside exact scope;
- route registration or `server.js` modification;
- production profile/key/clock/replay-path configuration;
- caller-controlled authority;
- API/quota key as external identity;
- memory/JSON replay or stubbed positive durability/concurrency;
- queue, `202`, retry or compensation;
- new dependency, npm export, schema, error vocabulary, version, deployment or
  release change;
- secret/internal leakage;
- production V2 writing beyond the existing exact owner;
- historical V1 rewrite, rehash or backfill;
- internet, TLS, proxy, multi-client or multi-instance scope;
- production-reachability, V4-complete or V5-complete claim; or
- weakening any fail-closed boundary.

Any such need requires a separate exact-base amendment.

## Definition of Done

Authorization closes only when:

1. exactly this task-pack changes;
2. exact base, three-file scope and ownership split are unambiguous;
3. production registration remains forbidden;
4. outer-guard ordering is explicit without authority inference;
5. real profile, clock, SQLite replay, SDK/Authority and mutation owner are
   composed only in tests;
6. restart, concurrency, Authority replay and journal replay remain distinct;
7. spoofed, malformed and unknown outcomes fail closed without retry;
8. response/durable evidence is exact and secret-free;
9. route absence, line budgets and package boundary are proven;
10. exact-head CI, source-first review, merge and post-merge smoke pass; and
11. reconciliation opens only
    `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_IMPLEMENTATION`.

## Non-Claims

This authorization does not provide or authorize:

- a registered/reachable production route or real-server modification;
- production trust/clock/replay/SDK/mutation composition;
- deployment configuration or replay path;
- transport credentials as authority;
- multi-client, multi-process or internet-facing deployment;
- new public schema/status/error/package surface;
- queue, asynchronous review or retry;
- V2 writing beyond the existing exact owner;
- interoperability beyond bounded local smoke;
- Enablement closeout, V4 or V5 completion; or
- release, dependency, marketplace or badge changes.
