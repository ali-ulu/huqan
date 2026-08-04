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
- Mode: docs-only authorization for a test-only, locally isolated route
  integration and adversarial proof
- Production route registration: forbidden
- `server.js` modification: forbidden
- Deployment configuration: forbidden

The exact base is the PR #230 reconciliation merge and canonical `main`. This
document authorizes no runtime behavior by itself. A later implementation must
start from the exact post-merge `main` SHA and may change only the three
test-owned files named below.

## Source-Reality Findings

At the exact base:

1. `lib/external-client-endpoint-contract.js` reserves exactly
   `POST /api/external-client/packages/admit`. Both `disabled` and `requested`
   states keep route, authority, replay, mutation and writer readiness false.
2. `server.js` does not import the endpoint contract or HTTP adapter and does
   not register the reserved path. The real server preserves its generic `404`.
3. `server.js` applies the existing module-global rate limiter before pathname
   dispatch. Authenticated endpoints then use `requireApiKey`; the API key is
   an outer transport-access guard only.
4. `requestGuards.js` exposes `checkRateLimit()` and `requireApiKey()`. Its
   process-local rate-limit map is not an external-client replay owner.
5. `lib/external-client-trust-config.js` materializes one exact immutable
   server-owned profile from an explicitly supplied object. No production
   profile loader exists.
6. `lib/external-client-replay-store.js` provides a dedicated SQLite owner from
   an explicitly supplied absolute database path and can be closed/reopened
   against the same file. No production replay-path source exists.
7. `lib/sdk.js` can pre-bind identity, workspace, package scope, permission,
   trusted keys, trusted clock, replay owner and package handler behind
   `createAxiomClient()`.
8. `lib/external-client-mutation-receipt-owner.js` owns the exact synchronous
   candidate quarantine and canonical V2 receipt through
   `Graph.runMutationOnce()`.
9. `lib/external-client-http-adapter.js` consumes one bounded
   `{ package, signature }` request and returns a frozen descriptor. It writes
   no socket and owns no authentication, trust, replay, mutation or receipt
   semantics.
10. No production source composes those owners together.
11. `package.json` uses `node --test` and does not publish the endpoint, trust,
    replay, mutation or adapter modules. The authorized test files remain
    outside the package surface.
12. This task-pack path was absent before the authorization branch.

Graphify and local clone bootstrap are unavailable in the connector-only
environment because GitHub DNS cannot be resolved. Live source, exact Git
ancestry, tests and CI control this authorization.

## Decision

Route Adversarial-0 is an **evidence gate**, not production registration.

The implementation will add one locally isolated test harness that composes
only existing owners:

```text
existing rate limiter
  -> existing API-key guard
  -> existing HTTP Adapter-0
  -> existing pre-bound SDK/Authority-0 use case
  -> existing Durable Replay-0 owner
  -> existing Mutation/Receipt Owner-0
  -> existing Graph SQLite transaction, journal and receipt
```

The harness may create an ephemeral loopback HTTP server only inside tests. It
must close every server, replay store, Graph/database, timer and temporary file.
It may generate test-only Ed25519 keys. It must not expose a stable port, mutate
the real server singleton, add production configuration or claim reachability.

The implementation is split across three test-owned files to preserve narrow
responsibilities and the repository's review convention. Each file must remain
at or below 300 physical lines.

## Authorized Implementation Files

```text
test/external-client-route-adversarial.test.js
test/helpers/external-client-route-harness.js
test/helpers/external-client-route-fixture.js
```

Ownership is exact:

- `test/external-client-route-adversarial.test.js` registers tests and owns
  assertions only;
- `test/helpers/external-client-route-harness.js` owns loopback server/client,
  outer-guard ordering, adapter-to-socket mapping and network cleanup only;
- `test/helpers/external-client-route-fixture.js` owns test keys, signed package,
  temporary SQLite profile/replay/Graph composition, durable-state reads and
  cleanup only.

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

The helpers are test-only. They may import production modules read-only but may
not monkey-patch exports, mutate production constants or create hidden mutable
registries.

## Exact Harness Contract

### Local HTTP ordering

The harness binds only to loopback on an operating-system-selected port and
uses a real Node HTTP client. Its test-local listener must run in this order:

1. derive one bounded test-local rate-limit key;
2. call existing `checkRateLimit()`;
3. reject quota failure before API-key evaluation, body consumption, adapter,
   replay or mutation;
4. call existing `requireApiKey()` with an explicit test key;
5. reject authentication failure before body consumption, adapter, replay or
   mutation;
6. call HTTP Adapter-0 only for the exact reserved path;
7. copy only the adapter descriptor's status, headers and JSON body to socket;
8. return a generic test-local `404` for every other path.

Neither API key nor rate-limit key may become identity, workspace, permission,
trusted-key, trust-root or replay authority. The harness must use unique quota
keys and remove only state it created.

### Server-owned composition

The fixture must build one authoritative profile with
`materializeExternalClientTrustConfig()` and bind outside request bytes:

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

The request body remains exactly `{ package, signature }`.

The package handler delegates exactly once to
`commitExternalClientCandidateClaim()` using the existing SDK-supplied
Authority-0 context. It must not reconstruct authority from request fields.

### Durable replay and mutation evidence

The fixture uses a real temporary SQLite replay database and a real temporary
SQLite Graph database. JSON, process memory and best-effort replay substitutes
do not qualify.

A valid first request must produce:

- HTTP `201` and the exact six-field Adapter-0 success body;
- one local candidate with forced pending/flag state;
- one completed mutation-journal result;
- one canonical V2 receipt with
  `trustRoot: external_verified_client`, review decision/verdict and pending
  status; and
- identifiers matching the HTTP response.

After closing and reopening the replay owner on the same database, identical
signed evidence must be rejected before a second mutation. Candidate, journal
and receipt counts remain unchanged.

Mutation-journal replay and Authority replay are separate claims. A separate
case may reuse an already authoritative context to call the mutation owner and
prove Adapter-0's exact `200` mapping only when the existing journal result
returns `replayed: true`. It must not describe that as a second Authority
admission.

### Concurrency

Two concurrent HTTP requests carrying identical valid evidence produce exactly
one successful quarantine and one replay rejection. Durable state contains
exactly one candidate, one completed mutation journal record and one canonical
receipt afterward.

Positive durability/concurrency claims must use the real SQLite owners. Stubs
may be used only for negative malformed-dependency classification tests and must
be labeled as such.

### Real-server absence

Load the real `server.js` with auto-listen disabled and bind it on an ephemeral
loopback port without source changes. In both configuration states:

```text
disabled
requested
```

`POST /api/external-client/packages/admit` retains generic `404`. A requested
value does not import the adapter, create replay state, mutate Graph or make a
readiness bit true. Close the HTTP listener and invoke the existing narrow
resource cleanup; never kill unrelated processes.

### Rejection matrix

The test must prove zero new candidate, journal and receipt rows for:

- missing or wrong API key;
- rate-limit exhaustion;
- wrong method;
- missing, duplicated, conflicting or expanded content type;
- malformed or conflicting content length;
- declared or observed overflow;
- empty body, malformed JSON and invalid UTF-8;
- primitive, array or unknown envelope;
- literal `__proto__`, depth `33` and aggregate value `10_001`;
- body-supplied identity, workspace, package scope, permission, trusted key,
  trust root, clock, replay, handler or retry authority;
- malformed signature and invalid package semantics;
- stale, future-dated, revoked, unknown-key and wrong-scope signatures; and
- profile/package identity or workspace mismatch.

Failure bodies must not expose API keys, key material, signatures, package
bytes, profile data, replay keys, database paths, internal codes/messages,
details or stacks.

### Unknown outcomes

Cover these distinct classes:

1. package handler rejects before mutation;
2. replay reservation fails or returns a hostile result;
3. mutation owner reports `OUTCOME_UNKNOWN`;
4. dependency returns mutable, partial or inconsistent success; and
5. client disconnect, stream abort or timeout occurs before delegation.

Each settles once, performs no retry, invokes no second handler or reservation
and leaks no internal evidence. Unknown mutation outcome maps to bounded `503`;
do not claim rollback unless durable evidence proves it.

### Response boundary

Successful socket responses match Adapter-0 exactly:

- `201` for a new quarantine;
- `200` only for an exact mutation-journal replay;
- `Content-Type: application/json; charset=utf-8`;
- `Cache-Control: no-store`; and
- exactly six approved success fields.

Failures use only the bounded outer-guard response or Adapter-0
`{ ok: false }` body from the layer that rejects. No public error vocabulary is
added.

## Required Test Groups

The assertion owner must prove at least:

1. real server stays `404` under disabled and requested states;
2. rate limit then API-key guard precede adapter/body;
3. valid first request returns `201` and commits exact durable evidence;
4. concurrent duplicates produce one allow, one replay rejection and one
   durable outcome;
5. replay close/reopen rejects identical evidence without a second mutation;
6. journal replay is distinct and maps to exact `200`;
7. caller-controlled authority and malformed transport fail closed;
8. signature, key, freshness, package and scope failures create no rows;
9. handler, replay and unknown mutation outcomes never retry;
10. responses contain no secret or internal evidence;
11. all resources are deterministically closed;
12. static source proof shows `server.js` still lacks route and adapter import;
13. exact diff contains only the three authorized test files, each at most 300
    lines;
14. `npm pack --dry-run` excludes the three test files and all internal
    external-client owners; and
15. an external-client smoke uses a real HTTP client and matches returned IDs to
    durable candidate/journal/receipt state.

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
only the three authorized test files change
each authorized file is at most 300 physical lines
no runtime or package file changes
```

Exact counts must be reported when available. Green CI without count output is
reported as a workflow conclusion only.

## Stop Conditions

Stop with `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_BLOCKED_CONTRACT_CONFLICT` if the
proof requires:

- any file outside the exact three-file scope;
- route registration or `server.js` modification;
- production profile, key, clock or replay-path configuration;
- request-controlled identity, workspace, permission, key, trust root, clock,
  replay, mutation or receipt authority;
- generic API key or quota key as external-client identity;
- process-memory or JSON replay for a positive claim;
- a stubbed positive durability or concurrency claim;
- queue, `202`, retry or compensation;
- new dependency, npm export, schema, error vocabulary, version, deployment or
  release change;
- leakage of internal/secret evidence;
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
3. production route registration remains forbidden;
4. outer guard ordering is explicit without authority inference;
5. real profile, clock, SQLite replay, SDK/Authority and mutation owner are
   composed only in tests;
6. restart, concurrency, Authority replay and journal replay are separately
   evidenced;
7. spoofed, malformed and unknown outcomes fail closed without retry;
8. response and durable evidence are exact and secret-free;
9. route absence, line budgets and package exclusion are proven;
10. exact-head CI, source-first review, merge and post-merge smoke pass; and
11. reconciliation opens only
    `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0_IMPLEMENTATION`.

## Non-Claims

This authorization does not provide or authorize:

- a registered, reachable or enabled production route;
- modification of the real server request listener;
- production trust/clock/replay/SDK/mutation composition;
- production deployment configuration or replay path;
- transport credentials as identity or authority;
- multi-client, multi-process or internet-facing deployment;
- new public schema, status, error code or package surface;
- queue, asynchronous review or retry;
- production V2 writing beyond the existing exact owner;
- interoperability beyond bounded local test smoke;
- Enablement closeout, V4 or V5 completion; or
- release, dependency, marketplace or badge changes.
