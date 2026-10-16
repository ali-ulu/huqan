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
`main`. This document authorizes no implementation by itself. A later
implementation must start from the exact post-merge `main` SHA and may change
only the two files named below.

## Source-Reality Findings

The exact base contains the required domain owners but no transport composition:

1. `lib/external-client-endpoint-contract.js` reserves exactly
   `POST /api/external-client/packages/admit`. Its configuration is only
   `disabled | requested`; every reachability and readiness bit remains false.
2. `lib/external-client-trust-config.js` materializes one bounded server-owned
   profile and does not read environment, filesystem or network state.
3. `lib/external-client-replay-store.js` owns durable SQLite replay reservation
   and remains internal and unwired.
4. `lib/external-client-authority.js` verifies identity, workspace, permission,
   trusted-key validity, signed-package freshness and replay reservation before
   handler execution.
5. `lib/sdk.js` exposes the in-process `admitExternalPackage()` orchestration.
   Its input still contains identity and workspace, so an HTTP request must
   never call it directly with caller-selected authority fields.
6. `lib/external-client-mutation-receipt-owner.js` owns the synchronous
   candidate-quarantine mutation and V2 receipt result with
   `outcome: pending_review`.
7. `requestGuards.js` already defines
   `DEFAULT_MAX_UPLOAD_BODY = 1_048_576`, the generic API-key guard and the
   server rate limiter.
8. `server.js` does not register the reserved route and does not import the
   endpoint contract, authority, replay owner, mutation owner or SDK admission
   path.
9. `package.json` does not publish the endpoint contract, trust materializer,
   replay owner or mutation/receipt owner. The adapter must remain internal.

Graphify output is unavailable in the connector-only environment. Live source,
exact Git ancestry, tests and CI therefore control this contract.

## Decision

HTTP Adapter-0 is one internal, unreachable transport boundary. It may:

- accept a Node-compatible request stream after a future route has applied the
  existing outer API-key and rate-limit guards;
- enforce exact method, media type, declared and observed body-byte limits,
  a fixed read timeout and exact JSON envelope shape;
- call exactly one injected, pre-bound package-admission use case once;
- map the existing bounded admission result or error to a frozen HTTP response
  descriptor.

It may not own or reconstruct client identity, workspace, package scope,
permission, trusted keys, clock, freshness, replay, mutation or receipt
semantics. Future server composition must capture those dependencies behind an
injected function that accepts only `{ package, signature }`.

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
`lib/external-client-endpoint-contract.js` and keep the body limit identical to
`requestGuards.DEFAULT_MAX_UPLOAD_BODY`. Neither bound is caller-configurable.

### Factory and dependency shape

The module must expose one factory equivalent to:

```text
createExternalClientHttpAdapter({ admitPackage })
```

The options value must be a plain exact-shape object with one enumerable own
data property named `admitPackage`, and that value must be a function. Unknown,
inherited, accessor-backed, non-enumerable and symbol properties fail before an
adapter is returned.

The returned adapter is frozen and exposes one callable boundary equivalent to:

```text
handle(request) -> Promise<responseDescriptor>
```

`admitPackage` is a trusted, pre-bound application use case supplied by future
server composition. Its only argument is a deeply frozen exact-shape object:

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

The adapter accepts only `POST`. Any other method returns `405` with
`Allow: POST` before body consumption and without calling `admitPackage`.

The only accepted media types are case-insensitive equivalents of:

```text
application/json
application/json; charset=utf-8
```

Whitespace around the single charset parameter may be normalized. Missing,
array-valued, malformed, wildcard, suffix-only, duplicated or additional media
parameters return `415` before JSON parsing and delegation.

### Body reading

The adapter owns exactly one bounded read of the supplied request stream:

- reject a valid declared `Content-Length` greater than `1_048_576` before
  attaching data listeners;
- reject negative, fractional, conflicting/array-valued or malformed declared
  lengths;
- count observed bytes from `Buffer`, `Uint8Array` and string chunks;
- accept at most `1_048_576` observed bytes and return `413` one byte over;
- decode with a fatal UTF-8 decoder so invalid byte sequences return `400`;
- stop, detach listeners and settle once on overflow, abort, error or timeout;
- return `408` after `5_000` milliseconds;
- consume the stream at most once and never retry;
- never include parser, stream or system error text in a response.

An empty body and malformed JSON return `400`. A pre-parsed object is not an
accepted substitute for the bounded byte stream.

### Exact JSON envelope

`JSON.parse` is the only decoder. It is not injectable. Therefore accessor,
symbol, Proxy, cycle and non-enumerable object shapes cannot be introduced by
an attacker at this boundary. The implementation must not add a reviver or a
caller-supplied parser.

After parsing, the top-level value must be a plain object with exactly two
enumerable own data properties, in any order:

```text
package
signature
```

A JSON key named `__proto__` or any unknown authority/control key returns `400`.
The request may not include:

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
owned by the existing package gate and domain owners. The adapter must not
reimplement their canonical validation.

Before delegation, the adapter must iteratively walk the parser-created JSON,
reject any depth above `32` or more than `10_000` aggregate values, create a
detached copy and deeply freeze the exact `{ package, signature }` input. The
walk must use one shared aggregate budget for the complete request envelope.
This transport bound is defensive and does not replace existing domain
validation.

### Outer authentication and rate-limit ownership

The current generic server API key is only an outer transport-access guard. It
must never become external-client identity, workspace, permission or trust-root
authority.

Adapter-0 does not import or call `requireApiKey`, `extractApiKey`,
`checkRateLimit` or the module-global rate-limit map. A future route must invoke
those existing outer guards before calling the adapter. Registration and proof
of that order belong to `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0`.

### Delegation and unknown outcomes

For a valid request, `admitPackage` is invoked exactly once. The adapter awaits
that call and never retries, compensates, reserves again or invokes a second
handler after rejection, timeout or an unknown result.

A successful dependency result must be the existing frozen SDK result with an
own data property `ok: true` and a frozen `admission` result containing own data
properties equivalent to:

```text
ok: true
outcome: pending_review
replayed: boolean
operationId: non-empty bounded string
localCandidateId: non-empty bounded string
receiptId: non-empty bounded string
```

The adapter must not infer success from a truthy value, HTTP-like status, gate
result or authority result alone. Missing, accessor-backed, mutable, partial or
semantically inconsistent success data is an unknown dependency outcome.

### Response descriptors

Every returned descriptor is deeply frozen and contains exactly:

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

A new synchronous quarantine returns `201`. An existing exact mutation-journal
result with `replayed: true` returns `200`. Neither path returns `202`.

The success body contains exactly six fields:

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
Authority receipt, gate receipt, receipt payload, database path, stack, error
details or injected dependencies.

Every failure body is exactly:

```text
{ ok: false }
```

No new public error vocabulary is introduced. Existing internal error codes may
be used only for status classification and are never returned.

| Condition | Status |
| --- | ---: |
| Wrong method | 405 |
| Unsupported or malformed media type | 415 |
| Declared or observed body too large | 413 |
| Read timeout | 408 |
| Empty, malformed, invalid UTF-8 or invalid envelope | 400 |
| Existing identity/workspace/signature/permission/key/freshness rejection | 403 |
| Existing replay detection or local candidate collision | 409 |
| Existing package/candidate semantic rejection | 422 |
| Missing server composition, replay reservation failure, mutation `OUTCOME_UNKNOWN`, dependency rejection or malformed success result | 503 |
| Any adapter-internal unclassified failure | 500 |

### Required ordering

One invocation runs in this exact order:

1. check method;
2. validate exact content type and declared length;
3. read once under byte and timeout bounds;
4. fatally decode UTF-8 and parse with non-injectable `JSON.parse`;
5. enforce exact envelope/signature shape and iterative depth/value bounds;
6. create the detached frozen `{ package, signature }` snapshot;
7. call `admitPackage` once;
8. validate the existing success result or classify the failure;
9. return one frozen response descriptor.

No API-key decision, rate-limit mutation, identity selection, replay
reservation, Graph mutation or receipt construction occurs inside the adapter.

## Required Adversarial Tests

The implementation test must prove at least:

1. valid `POST` JSON delegates once and maps an exact existing admission result
   to frozen `201` and replayed `200` descriptors;
2. wrong method returns `405`, sets `Allow: POST`, attaches no body listeners
   and does not delegate;
3. missing, array-valued, malformed and parameter-expanded media types return
   `415` before delegation;
4. oversized or malformed declared length fails before body consumption;
5. observed size at the exact bound is accepted and one byte over returns
   `413` without delegation;
6. empty body, invalid UTF-8, malformed JSON, primitive, array and unknown
   top-level envelopes return `400`;
7. caller identity, workspace, permission, trusted-key, trust-root, replay and
   retry fields are rejected;
8. a literal `__proto__` JSON key is rejected and no parser/reviver dependency
   can be injected;
9. exact depth `32` and aggregate value `10_000` boundaries pass while depth
   `33` and value `10_001` fail before delegation;
10. the delegated input is exact-shape, deeply frozen and detached from request
    chunks;
11. stream abort, error and timeout detach listeners, settle once and never
    delegate or retry;
12. exact known failure groups map to the required status without code,
    message, details or stack leakage;
13. mutation `OUTCOME_UNKNOWN`, dependency rejection and malformed success map
    to `503` and never retry;
14. success cannot be inferred from truthy, partial, gate-only or
    authority-only values;
15. success exposes only the six approved body fields;
16. response descriptors, headers and bodies are immutable and exact-shape;
17. static source proof shows no direct SDK, Authority, trust-config, replay,
    mutation-owner, Graph, Kernel, storage or server import;
18. static source proof shows `server.js` still lacks the reserved route and
    adapter import;
19. package dry-run proves the adapter and test are not published;
20. the exact implementation diff contains only the two authorized files.

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

Stop with `EXTERNAL_CLIENT_HTTP_ADAPTER_0_BLOCKED_CONTRACT_CONFLICT` if the
implementation requires:

- any file outside the exact two-file scope;
- route registration, `server.js` or deployment configuration changes;
- request-controlled identity, workspace, package scope, permission, trusted
  key, trust root, clock, replay state, mutation or receipt fields;
- direct SDK, Authority, trust-config, replay-store, mutation-owner, Graph,
  Kernel or storage imports;
- an adapter-owned API-key store, registry, rate-limit map, replay store, queue,
  database, clock or handler registry;
- a memory-only pending queue or `202 Accepted`;
- a new dependency, npm export, package version, public schema or public error
  code;
- leakage of internal codes, messages, details, stack, package bytes,
  signatures, trusted-key, replay or receipt payloads;
- retry or compensation after stream, dependency, mutation or receipt unknown
  outcomes;
- production route reachability or global V2 writer claims;
- weakening any existing fail-closed boundary.

Any such need requires a separate exact-base amendment.

## Definition of Done

Authorization closes only when:

1. exactly this task-pack changes;
2. exact base and two-file implementation scope are unambiguous;
3. request authority is limited to package and signature bytes while all trust
   decisions remain server-owned behind injection;
4. method, media type, byte, timeout, envelope, depth and value bounds are fixed;
5. outer API-key and rate-limit ownership remain future route concerns;
6. delegation occurs exactly once and unknown outcomes never retry;
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
- a production configuration or database-path source;
- transport credentials as external-client identity or authority;
- multi-client, multi-workspace, multi-instance or public deployment behavior;
- mutation or receipt semantics inside the adapter;
- a pending queue, asynchronous workflow or automatic retry;
- public npm exposure, dependency, package, version or release changes;
- production V2 writing beyond the already bounded internal owner;
- Route Adversarial-0, Enablement-0 closeout, V4 or V5 completion.
