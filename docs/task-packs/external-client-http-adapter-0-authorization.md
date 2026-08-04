# EXTERNAL-CLIENT-HTTP-ADAPTER-0 — Authorization

## Gate Identity

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact authorization base: `main @ e2418230a0d9e0da7f93b0a04cc8e59b96741986`
- Checkpoint gate: `EXTERNAL_CLIENT_HTTP_ADAPTER_0_AUTHORIZATION`
- Governing sequence: `docs/task-packs/external-client-enablement-0-authorization.md`
- Closed predecessors: Identity/Trust Config-0, Durable Replay-0 and Mutation/Receipt Owner-0
- Mode: docs-only authorization for one unreachable, thin HTTP transport adapter
- Reachable HTTP route: forbidden
- `server.js` modification: forbidden
- Production deployment configuration: forbidden

The exact base is the PR #202 reconciliation merge and current canonical
`main`. This authorization does not implement the adapter. The implementation
requires a separate exact post-merge base and may change only the files listed
below.

## Source-Reality Findings

The exact base contains the required domain owners but no transport composition:

1. `lib/external-client-endpoint-contract.js` reserves exactly
   `POST /api/external-client/packages/admit`. Its configuration is only
   `disabled | requested`; every reachability and readiness bit remains false.
2. `lib/external-client-trust-config.js` materializes one bounded server-owned
   client profile. It does not read environment, filesystem or network state.
3. `lib/external-client-replay-store.js` owns durable SQLite replay reservation
   and remains internal and unwired.
4. `lib/external-client-authority.js` verifies identity, workspace, permission,
   trusted-key validity, signed-package freshness and replay reservation before
   handler execution.
5. `lib/sdk.js` exposes the in-process `admitExternalPackage()` orchestration.
   Its call still receives identity and workspace, so an HTTP request must never
   call it directly with caller-selected authority fields.
6. `lib/external-client-mutation-receipt-owner.js` owns the exact synchronous
   candidate-quarantine mutation and canonical V2 receipt result with
   `outcome: pending_review`.
7. `requestGuards.js` already defines the reusable upload bound
   `DEFAULT_MAX_UPLOAD_BODY = 1_048_576`, generic API-key guard and server rate
   limiter.
8. `server.js` does not register the reserved external-client route and does
   not import the endpoint contract, authority, replay owner, mutation owner or
   SDK admission path.
9. `package.json` does not publish the endpoint contract, trust materializer,
   replay owner or mutation/receipt owner. The future adapter must remain
   internal as well.

Graphify output is not available in the connector-only execution environment.
Live source, exact Git ancestry, tests and CI therefore control this contract.

## Decision

HTTP Adapter-0 is one internal, unreachable transport boundary. It may:

- accept a Node-compatible request stream only after a future route has applied
  the existing outer API-key and rate-limit guards;
- enforce the exact method, media type, declared and observed body-byte limit,
  read timeout and top-level JSON shape;
- call exactly one injected, pre-bound package-admission use case once;
- map the existing bounded admission result or error to a frozen HTTP response
  descriptor.

It may not own or reconstruct client identity, workspace, package scope,
permission, trusted keys, clock, freshness, replay, mutation or receipt
semantics. Those values must be captured by future server composition inside
an injected function that accepts only `{ package, signature }`.

The adapter returns a response descriptor. It does not write to a socket,
register a route, read deployment configuration or make the endpoint reachable.

## Authorized Implementation Files

```text
lib/external-client-http-adapter.js
lib/external-client-http-adapter.test.js
```

No other implementation file is authorized. In particular, do not modify:

```text
server.js
requestGuards.js
lib/sdk.js
lib/external-client-endpoint-contract.js
lib/external-client-trust-config.js
lib/external-client-replay-store.js
lib/external-client-authority.js
lib/external-client-mutation-receipt-owner.js
package.json
```

## Exact Adapter Contract

### Version and fixed transport bounds

The module must export immutable constants equivalent to:

```text
EXTERNAL_CLIENT_HTTP_ADAPTER_VERSION = external-client-http-adapter-0-v1
EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES = 1_048_576
EXTERNAL_CLIENT_HTTP_READ_TIMEOUT_MS = 5_000
```

The implementation must reuse the reserved endpoint method from
`lib/external-client-endpoint-contract.js` and must keep the max-body value
identical to `requestGuards.DEFAULT_MAX_UPLOAD_BODY`. Neither bound is caller
configurable in Adapter-0.

### Factory and dependency shape

The module must expose one factory equivalent to:

```text
createExternalClientHttpAdapter({ admitPackage })
```

The options object must be a plain exact-shape object with one enumerable own
data property, `admitPackage`, whose value is a function. Unknown, inherited,
accessor-backed, non-enumerable or symbol properties fail before an adapter is
returned.

The returned adapter must be frozen and expose one callable boundary equivalent
to:

```text
handle(request) -> Promise<responseDescriptor>
```

`admitPackage` is a trusted, pre-bound application use case supplied by later
server composition. Its only input is a deeply frozen exact-shape object:

```text
{
  package,
  signature
}
```

It must not receive the raw request, headers, API key, remote address,
configuration object, filesystem path, clock, trusted keys, replay owner, Graph
or server references.

Future composition may bind the existing SDK, Authority-0, durable replay owner
and Mutation/Receipt Owner-0 behind this function. That composition is not part
of Adapter-0 implementation.

### Method and media type

The adapter accepts only:

```text
POST
```

Any other method returns a `405` descriptor with `Allow: POST` before body
consumption and without calling `admitPackage`.

The only accepted media types are case-insensitive equivalents of:

```text
application/json
application/json; charset=utf-8
```

Whitespace around the single charset parameter may be normalized. Duplicate,
array-valued, missing, malformed, wildcard, suffix-only or additional media
parameters return `415` before JSON parsing and without calling the use case.

### Body reading

The adapter owns one bounded read of the request stream:

- reject a valid declared `Content-Length` greater than `1_048_576` before
  attaching data listeners;
- reject negative, fractional, conflicting/array-valued or malformed declared
  lengths;
- count observed bytes from `Buffer`, `Uint8Array` or string chunks;
- stop, detach listeners and fail with `413` when observed bytes exceed the
  fixed bound;
- stop, detach listeners and fail with `408` after `5_000` milliseconds;
- map stream abort/error to a bounded `400` descriptor;
- consume the stream at most once;
- do not retry a failed or timed-out read;
- do not include parser, stream or system error text in the response.

An empty body and invalid UTF-8/JSON return `400`. The adapter must not accept a
pre-parsed caller object as a substitute for the bounded byte stream.

### Exact request body

After JSON parsing, the top-level body must be a plain object with exactly two
enumerable own data properties in any order:

```text
package
signature
```

Unknown, inherited, accessor-backed, non-enumerable, symbol or `__proto__`
properties fail closed. The body may not include:

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

The signature must be a plain exact-shape object with exactly:

```text
algorithm
keyId
value
```

All deeper package, signature, authority, replay and candidate semantics remain
owned by the existing gate and owners. The adapter must not duplicate their
validation or canonicalization.

Before delegation, the adapter must snapshot the parsed package and signature
as bounded deterministic JSON, reject cycles/hostile shapes without executing
getters and deeply freeze the injected use-case input. The snapshot may use a
maximum depth of `32` and one shared aggregate budget of `10_000` values for the
complete request body. This transport snapshot is a defensive boundary, not a
replacement for the existing package and mutation-owner validation.

### Outer authentication and rate-limit ownership

The existing generic server API key is only an outer transport-access guard. It
must never become external-client identity, workspace, permission or trust-root
authority.

Adapter-0 does not import or call `requireApiKey`, `extractApiKey`,
`checkRateLimit` or the module-global rate-limit map. A future route must invoke
the existing outer API-key and rate-limit guards before calling the adapter.
Route registration and proof of that ordering belong to
`EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0`.

### Delegation and unknown outcomes

For a valid request, `admitPackage` is invoked exactly once. The adapter must
await that single call and must never retry, compensate, reserve again or call a
second handler after any rejection, timeout or unknown result.

A successful dependency result must be the existing SDK result with `ok: true`
and one bounded Mutation/Receipt Owner-0 `admission` result. The admission must
contain the existing exact values required for a successful quarantine,
including:

```text
ok: true
outcome: pending_review
replayed: boolean
operationId
localCandidateId
receiptId
```

A missing, malformed, accessor-backed, mutable or semantically inconsistent
success result is an internal failure. The adapter must not infer success from
an HTTP-like status, truthy value, gate result or authority result alone.

### Response descriptors

Every returned descriptor must be deeply frozen and contain exactly:

```text
statusCode
headers
body
```

All responses use:

```text
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
```

Successful synchronous quarantine returns `201`, never `202`, with exactly:

```text
{
  ok: true,
  outcome: "pending_review",
  replayed: <boolean>,
  operationId: <existing bounded ID>,
  localCandidateId: <existing bounded ID>,
  receiptId: <existing bounded ID>
}
```

The adapter must not expose package bytes, signatures, API keys, trusted-key
material, identity subjects, workspace configuration, package hash, replay key,
Authority receipt, gate receipt, receipt payload, database path, internal stack,
error details or injected dependencies.

Failure bodies contain exactly:

```text
{ ok: false }
```

No new public error vocabulary is introduced by Adapter-0. Exact status mapping:

| Condition | Status |
| --- | ---: |
| Wrong method | 405 |
| Unsupported/malformed media type | 415 |
| Declared or observed body too large | 413 |
| Read timeout | 408 |
| Empty, malformed or hostile JSON/body shape | 400 |
| Existing signature, identity, workspace, package-scope, permission, key-validity or freshness rejection | 403 |
| Existing replay-detected result | 409 |
| Existing candidate/package semantic rejection | 422 |
| Existing mutation `OUTCOME_UNKNOWN`, dependency throw/rejection or malformed success result | 503 |
| Any unclassified internal failure | 500 |

Only the status code is exposed. Existing internal error codes may be used for
classification but must not be returned in the response body or headers.

## Required Ordering

For one invocation, ordering is exactly:

1. validate request object and method;
2. validate exact content type and declared length;
3. read the stream once under byte and timeout bounds;
4. parse JSON and enforce the exact top-level/signature shape;
5. create the bounded frozen `{ package, signature }` snapshot;
6. call the injected `admitPackage` once;
7. validate the existing bounded success result or classify the failure;
8. return one frozen response descriptor.

No API-key decision, rate-limit mutation, identity selection, replay reservation,
Graph mutation or receipt construction occurs inside the adapter itself.

## Required Adversarial Tests

The implementation test must prove at least:

1. exact `POST` plus accepted JSON media type delegates once and maps a valid
   existing admission result to the exact frozen `201` descriptor;
2. wrong method returns `405` and does not attach body listeners or delegate;
3. missing, duplicate, array-valued, malformed and parameter-expanded content
   types return `415` before delegation;
4. declared length above the bound or malformed declared length fails before
   body consumption;
5. observed body size at the exact bound is accepted and one byte over returns
   `413` without delegation;
6. empty, invalid UTF-8, malformed JSON, primitive, array and unknown top-level
   shapes return `400`;
7. body-level identity, workspace, permission, key, trust-root, replay and retry
   fields are rejected;
8. inherited, accessor-backed, non-enumerable, symbol and `__proto__` shapes do
   not execute attacker code and fail closed where representable;
9. dense-array, depth-33, 10,001-value, cycle and Proxy-hostile snapshots fail
   before delegation;
10. the injected input is exact-shape, deeply frozen and detached from request
    chunks and parsed-body mutation;
11. stream error, abort and timeout detach listeners, settle once and never
    delegate or retry;
12. dependency rejection groups map to the exact statuses without code,
    message, details or stack leakage;
13. mutation `OUTCOME_UNKNOWN`, thrown/rejected dependency and malformed success
    result map to `503` and never retry;
14. success cannot be inferred from truthy, partial, gate-only or authority-only
    results;
15. success exposes only the six approved body fields and no gate, authority,
    signature, replay or receipt internals;
16. all descriptors, headers and bodies are immutable and exact-shape;
17. static source proof shows the adapter does not import `server.js`, SDK,
    authority, trust config, replay store, mutation owner, Graph, Kernel,
    storage or package metadata;
18. static source proof shows `server.js` still lacks the reserved route,
    endpoint-contract import and adapter import;
19. package dry-run proves the new internal adapter and test are not published;
20. exact implementation diff contains only the two authorized files.

## Required Validation Evidence

The implementation PR must carry exact-head evidence for:

```bash
node --test lib/external-client-http-adapter.test.js
node --test \
  lib/external-client-endpoint-contract.test.js \
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
external-client-http-adapter.js does not import server.js, sdk.js,
external-client-authority.js, external-client-trust-config.js,
external-client-replay-store.js, external-client-mutation-receipt-owner.js,
graph.js, kernel.js or storage.js
package.json does not publish external-client-http-adapter.js
```

## Stop Conditions

Stop and return `EXTERNAL_CLIENT_HTTP_ADAPTER_0_BLOCKED_CONTRACT_CONFLICT` if
implementation requires:

- any file outside the exact two-file scope;
- route registration, `server.js` or deployment configuration changes;
- request-controlled identity, workspace, package scope, permission, trusted
  key, trust root, clock, replay state, mutation or receipt fields;
- direct SDK, Authority, trust-config, replay-store, mutation-owner, Graph,
  Kernel or storage imports;
- an adapter-owned API-key store, client registry, rate-limit map, replay store,
  queue, database, clock or handler registry;
- a memory-only pending queue or `202 Accepted` response;
- a new dependency, public npm export, package version, public schema or public
  error code;
- error details, stack, package bytes, signature, trusted-key, replay or receipt
  payload leakage;
- retry or compensation after stream, dependency, mutation or receipt unknown
  outcomes;
- production route reachability or a global V2 writer claim;
- weakening existing Endpoint-0, Authority-0, replay, mutation or package-gate
  fail-closed behavior.

Any such need requires a separate exact-base amendment. It is not implicitly
authorized.

## Definition of Done

HTTP Adapter-0 authorization closes only when:

1. exactly this task-pack changes;
2. exact base and two-file implementation scope are unambiguous;
3. request authority is limited to package and signature bytes while identity,
   workspace and all trust decisions remain server-owned behind injection;
4. method, media type, byte, timeout, shape and snapshot bounds are fixed;
5. outer API-key and rate-limit ownership remain future route concerns and do
   not imply external-client authority;
6. the use case is called exactly once and unknown outcomes never retry;
7. success and failure descriptors are exact, bounded and secret-free;
8. route registration, server composition and package exposure remain absent;
9. exact-head CI, source-first falsification review, merge and post-merge smoke
   pass;
10. post-merge reconciliation opens only
    `EXTERNAL_CLIENT_HTTP_ADAPTER_0_IMPLEMENTATION`.

## Non-Claims

This authorization does not provide or authorize:

- a registered, reachable or enabled external-client route;
- server composition of trust config, replay store, SDK or mutation owner;
- a production configuration source or database-path source;
- transport credentials as client identity or authority;
- multi-client, multi-workspace, multi-instance or public deployment behavior;
- mutation or receipt semantics inside the adapter;
- a pending queue, asynchronous workflow or automatic retry;
- public npm exposure, dependency, package, version or release changes;
- production V2 writing beyond the already bounded internal owner;
- External Client Route Adversarial-0 or Enablement-0 closeout;
- V4 or V5 completion.
