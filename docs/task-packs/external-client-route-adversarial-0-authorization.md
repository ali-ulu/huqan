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
- Mode: docs-only authorization for one test-only, locally isolated route
  integration and adversarial proof
- Production route registration: forbidden
- `server.js` modification: forbidden
- Deployment configuration: forbidden

The exact base is the PR #230 reconciliation merge and canonical `main`. This
document authorizes no runtime behavior by itself. A later implementation must
start from the exact post-merge `main` SHA and may change only the single test
file named below.

## Source-Reality Findings

At the exact base:

1. `lib/external-client-endpoint-contract.js` reserves exactly
   `POST /api/external-client/packages/admit`. Both `disabled` and `requested`
   states keep `routeReachable`, authority readiness, replay readiness,
   mutation permission and receipt-writer readiness false.
2. `server.js` does not import the endpoint contract or HTTP adapter and does
   not register the reserved path. The real server therefore still returns its
   existing generic `404` for that path.
3. `server.js` applies the existing module-global rate limiter before pathname
   dispatch. Route-specific authenticated endpoints then apply
   `requireApiKey`; the API key establishes transport access only.
4. `requestGuards.js` exposes the existing `checkRateLimit()` and
   `requireApiKey()` guards. The rate-limit map is process-local and is not an
   external-client replay owner.
5. `lib/external-client-trust-config.js` can materialize one exact, immutable,
   server-owned client profile from an explicitly supplied object. It does not
   read environment, filesystem or network state and no production profile
   loader exists.
6. `lib/external-client-replay-store.js` provides a dedicated SQLite owner from
   an explicitly supplied absolute database path. It has exact `reserve()` and
   `close()` ownership and can be closed and reopened against the same database
   for restart evidence. No production replay-path source exists.
7. `lib/sdk.js` can pre-bind authoritative identity, workspace, package scope,
   permission, trusted keys, trusted clock, replay store and package admission
   handler behind `createAxiomClient()`. Request data must not supply those
   values.
8. `lib/external-client-mutation-receipt-owner.js` owns the exact synchronous
   candidate-quarantine mutation and canonical V2 receipt through
   `Graph.runMutationOnce()`.
9. `lib/external-client-http-adapter.js` accepts one Node-compatible request,
   consumes exactly a bounded `{ package, signature }` envelope and returns a
   frozen response descriptor. It writes no socket and owns no route,
   authentication, rate limiting, trust, replay, mutation or receipt semantics.
10. No production composition currently binds the profile, clock, replay owner,
    SDK, mutation owner and adapter together.
11. `package.json` runs test files through `node --test` and does not publish the
    endpoint contract, trust materializer, replay owner, mutation owner or HTTP
    adapter.
12. The expected task-pack at this path was absent before this authorization.

Graphify output and local clone bootstrap are unavailable in the connector-only
environment because GitHub DNS cannot be resolved. Live source, exact Git
ancestry, tests and CI control this authorization.

## Decision

Route Adversarial-0 is an **evidence gate**, not production registration.

The implementation will add one test-only locally isolated HTTP integration
harness. The harness must compose the already merged owners without introducing
new runtime code:

```text
existing outer rate limiter
  -> existing API-key guard
  -> existing HTTP Adapter-0
  -> existing pre-bound SDK/Authority-0 use case
  -> existing Durable Replay-0 owner
  -> existing Mutation/Receipt Owner-0
  -> existing Graph SQLite transaction, journal and receipt
```

The harness may create an ephemeral loopback HTTP server only inside the test
process and must close every server, replay store, graph/database and timer it
creates. It may use temporary directories and generated test-only Ed25519 keys.
It must not expose a stable port, change the real server singleton or create a
production configuration source.

The real `server.js` route remains absent. This gate proves that the bounded
components can be composed in the required order and remain fail-closed under
adversarial input before any later route-registration or deployment decision.

## Authorized Implementation File

```text
test/external-client-route-adversarial.test.js
```

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

The test may import those existing modules read-only. It may not monkey-patch
module exports, mutate production constants or rely on undocumented process
state shared with unrelated tests.

## Exact Test Harness Contract

### Local-only HTTP boundary

The harness must bind only to loopback using an operating-system-selected
port. It must send requests through a real Node HTTP client so method, headers,
stream chunks, connection close and socket response behavior are exercised.

The harness request listener must be test-local and preserve this order:

1. derive one bounded test-local rate-limit key;
2. call the existing `checkRateLimit()` outer guard;
3. reject a rate-limit failure before API-key evaluation, body consumption,
   adapter delegation, replay reservation or mutation;
4. call the existing `requireApiKey()` with an explicitly supplied test key;
5. reject authentication failure before body consumption, adapter delegation,
   replay reservation or mutation;
6. call the existing HTTP Adapter-0 only for the exact reserved path;
7. copy only the adapter's exact status, headers and JSON body to the socket;
8. return a generic test-local `404` for every other path.

Neither the API key nor the rate-limit key may become identity, workspace,
permission, trusted-key, trust-root or replay authority.

The test must use unique rate-limit keys and restore or clear only entries it
created so unrelated tests cannot inherit its quota state.

### Server-owned composition

The test must build exactly one authoritative client profile from test-owned
constants and generated public-key bytes using
`materializeExternalClientTrustConfig()`.

The test must bind all authority values outside the request:

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

The request body is limited to:

```text
{
  package,
  signature
}
```

The package-admission handler must delegate exactly once to
`commitExternalClientCandidateClaim()` with the Authority-0 context supplied by
the existing SDK. It must not reconstruct identity, workspace, replay or
receipt authority from request bytes.

### Durable replay and mutation ownership

The test must use a real temporary SQLite replay database through
`createExternalClientReplayStore()` and a real temporary SQLite Graph database.
No JSON, process-memory or best-effort fallback qualifies.

For a valid first request, the proof must observe:

- HTTP `201`;
- exact six-field success body from Adapter-0;
- one local candidate quarantine with forced pending/flag state;
- one completed mutation-journal result;
- one canonical V2 receipt with
  `trustRoot: external_verified_client`, review verdict/decision and pending
  status; and
- identifiers matching the HTTP response.

For the same signed evidence replayed after closing and reopening the replay
store on the same database, the proof must observe the existing bounded replay
rejection before a second mutation. The candidate, journal and receipt counts
must remain unchanged.

A separate exact mutation-journal replay case may use an already reserved,
authoritative context to prove Adapter-0's `200` mapping only when the existing
mutation owner returns `replayed: true`. Durable Authority replay rejection and
mutation-journal replay are distinct claims and must not be conflated.

### Concurrency

Two concurrent HTTP requests carrying identical valid signed evidence must
produce exactly one successful quarantine and one replay rejection. The proof
must observe exactly one candidate, one completed mutation-journal record and
one canonical receipt after both responses settle.

No test may weaken the replay store, pre-reserve outside Authority-0 merely to
force a desired result or replace the real SQLite uniqueness boundary with a
stub.

### Disabled and requested-but-unregistered state

The real `server.js` must be loaded with auto-listen disabled and exercised on a
loopback ephemeral port without changing its source.

For both endpoint configuration states:

```text
disabled
requested
```

`POST /api/external-client/packages/admit` must retain the existing generic
`404`. A requested value must not produce a new disabled-response schema,
import the adapter, create a replay database, mutate Graph state or make any
readiness bit true.

The proof must close the real server with its existing narrow close method and
must not kill unrelated Node processes.

### Spoofing and malformed input

The local integration harness must prove that request-controlled attempts to
supply any of the following fail before domain mutation:

```text
identity
identitySubject
identityKind
workspaceId
packageId
permissions
trustedKeys
trustRoot
clock
replayStore
replayKey
reservedAt
expiresAt
handler
retry
```

It must also prove:

- missing or wrong API key;
- rate-limit exhaustion;
- wrong method;
- missing, duplicated, conflicting or expanded content type;
- malformed or conflicting content length;
- declared and observed body overflow;
- empty body, malformed JSON and invalid UTF-8;
- primitive, array or unknown top-level envelope;
- literal `__proto__` key;
- depth `33` and aggregate value `10_001` rejection;
- malformed signature and invalid package semantics;
- stale, future-dated, revoked, unknown-key and wrong-scope signatures; and
- package identity/workspace mismatch against the server-owned profile.

For every rejection, the proof must assert zero new candidate, journal and
receipt rows. Failure bodies remain bounded and must not expose API keys,
private/public key material, signature values, package bytes, profile data,
replay keys, database paths, internal codes, messages, details or stacks.

### Handler failure and unknown outcome

The proof must cover at least these distinct failure classes:

1. package admission handler rejects before mutation;
2. replay reservation returns or throws a bounded failure;
3. mutation owner reports `OUTCOME_UNKNOWN` after transaction uncertainty;
4. dependency returns a mutable, partial or semantically inconsistent success
   shape; and
5. client disconnect, stream abort or adapter timeout occurs before delegation.

Each class must settle once, perform no automatic retry, invoke no second
handler, create no second replay reservation and expose no internal evidence.
An unknown mutation outcome must return Adapter-0's bounded `503`; the test must
not claim rollback unless the database evidence proves it.

### Response and evidence boundaries

Every successful socket response must match the adapter descriptor exactly:

- status `201` for a new quarantine;
- status `200` only for an exact mutation-journal replay;
- `Content-Type: application/json; charset=utf-8`;
- `Cache-Control: no-store`; and
- exactly the six approved success body fields.

Every failure response body is exactly the bounded outer-guard response or
Adapter-0 `{ ok: false }` body appropriate to the layer that rejected it. No
new public error vocabulary or response field is introduced.

The proof must query durable state through existing bounded Graph/read owners
or direct test-local SQLite inspection where no public read owner exists. It
must not alter production APIs merely to make evidence easier to read.

## Required Adversarial Test Groups

The single test file must prove at least:

1. real server preserves `404` for disabled and requested configuration;
2. local harness applies rate limit then API-key guard before adapter/body;
3. valid first HTTP request commits one candidate, journal result and V2 receipt
   and returns exact `201`;
4. identical concurrent HTTP requests produce one allow and one replay
   rejection with one durable mutation/receipt outcome;
5. replay store close/reopen rejects identical signed evidence with unchanged
   mutation counts;
6. mutation-journal replay is separately proven and maps to exact `200`;
7. body-supplied authority and spoofed workspace/identity fields fail closed;
8. wrong method, media type, header conflict, size, timeout, UTF-8, JSON,
   prototype and depth/value boundaries fail before mutation;
9. signature, key, freshness, package and scope failures create no domain rows;
10. handler, replay and mutation unknown-outcome failures never retry;
11. response and failure bodies contain no secret/internal evidence;
12. all created servers, timers, replay stores, graphs and temporary files are
    closed or removed deterministically;
13. static source proof shows `server.js` still lacks the reserved route and
    adapter import;
14. static source proof shows no production source file changed;
15. `npm pack --dry-run` still excludes endpoint, trust, replay, mutation,
    adapter and the new test file from the published package surface; and
16. an independent external-client smoke uses a real HTTP client and validates
    the durable candidate/journal/receipt identifiers returned by the response.

The file may organize these checks into grouped tests to control runtime, but a
passing group must not hide which boundary failed.

## Required Validation Evidence

The implementation PR must carry exact-head evidence for:

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

Static assertions must prove:

```text
server.js does not contain /api/external-client/packages/admit
server.js does not import external-client-http-adapter
only test/external-client-route-adversarial.test.js changes
no runtime or package file changes
```

The implementation report must list exact targeted and full-suite counts when
the execution surface returns them. A green workflow conclusion without counts
must be reported as such rather than inventing totals.

## Stop Conditions

Stop with `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_BLOCKED_CONTRACT_CONFLICT` if the
proof requires:

- any file outside the exact one-test-file scope;
- route registration or `server.js` modification;
- a production profile, key, clock or replay-database configuration source;
- request-controlled identity, workspace, permission, trusted key, trust root,
  clock, replay, mutation or receipt authority;
- treating the generic API key or rate-limit key as external-client identity;
- a process-memory or JSON replay substitute;
- stubbing the replay owner, Authority-0 or mutation owner for a positive
  durability/concurrency claim;
- a memory-only queue, `202 Accepted`, automatic retry or compensation;
- a new dependency, npm export, public schema, error vocabulary, package
  version, deployment or release change;
- leakage of internal codes, messages, details, stack, package bytes,
  signatures, trusted keys, replay evidence, receipt payloads or database paths;
- production V2 writing beyond the already authorized exact mutation owner;
- historical V1 rewrite, rehash or trust-root backfill;
- public internet, TLS, reverse proxy, multi-client or multi-instance scope;
- a production-reachability, V4-complete or V5-complete claim; or
- weakening any existing fail-closed boundary.

Any such need requires a separate exact-base amendment.

## Definition of Done

Authorization closes only when:

1. exactly this task-pack changes;
2. exact base and one-test-file implementation scope are unambiguous;
3. the gate remains evidence-only and production route registration stays
   forbidden;
4. outer rate-limit and API-key ordering are explicit without authority
   inference;
5. one server-owned profile, trusted clock, real SQLite replay owner, existing
   SDK/Authority and mutation/receipt owner are composed only inside the test;
6. restart, concurrency, mutation-journal replay and Authority replay are
   separately evidenced;
7. malformed, spoofed and unknown outcomes fail closed without retry;
8. response and durable mutation/receipt evidence are exact and secret-free;
9. static route absence and package-surface exclusion remain proven;
10. exact-head CI, source-first falsification review, merge and post-merge smoke
    pass; and
11. post-merge reconciliation opens only
    `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_IMPLEMENTATION`.

## Non-Claims

This authorization does not provide or authorize:

- a registered, reachable or enabled production external-client route;
- modification of the real server request listener;
- production composition of trust profile, clock, replay, SDK or mutation
  owner;
- a production deployment configuration or replay-database path source;
- transport credentials as identity or authority;
- a multi-client registry, multi-process shared deployment or internet-facing
  service;
- a new public schema, status, error code or package surface;
- a pending queue, asynchronous review flow or automatic retry;
- production V2 writing beyond the existing exact internal owner;
- external interoperability beyond the bounded local test smoke;
- Enablement-0 closeout, V4 Workbench or V5 ecosystem completion;
- release, package-version, dependency, marketplace or badge changes.
