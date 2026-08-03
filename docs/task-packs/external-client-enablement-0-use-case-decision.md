# EXTERNAL-CLIENT-ENABLEMENT-0-G0 - Use-Case and Ownership Decision

## Gate Identity

- Repository: `ali-ulu/huqan`
- Mode: docs-only source-reality and product-boundary decision
- Scope-definition base: `main` at
  `fc24b1b455d90733cb4028efa90a52e8125881ce`
- Closed predecessor evidence: Adversarial-0 at
  `3abb006a0c800577cdd8d4f0970eaed0a09b8319`
- Previous checkpoint:
  `EXTERNAL_CLIENT_ADVERSARIAL_0_CLOSEOUT_RECONCILIATION`
- Authorized successor after this gate closes:
  `EXTERNAL_CLIENT_ENABLEMENT_0_AUTHORIZATION`

The scope-definition base records the source state used for this decision. It
is not a future implementation base. Every later gate requires a separately
authorized exact post-merge `main` SHA.

## Source Reality

At the scope-definition base:

1. `server.js` has no external-client package-admission route or import;
2. the Endpoint-0 descriptor reserves
   `POST /api/external-client/packages/admit`, but `requested` configuration
   does not make the route reachable or ready;
3. the generic server API key proves only shared-secret possession and does
   not select external identity, workspace, trusted key, permission or trust
   root;
4. Authority-0 accepts only explicitly injected authority, trusted clock and
   atomic replay-owner dependencies;
5. no production trusted-key loader or external-client-compatible durable
   replay-reservation owner exists; the existing Graph SQLite mutation journal
   is not an Authority-0 replay-reservation implementation and does not prove
   pre-mutation reservation, TTL expiry or external-client ownership;
6. no production admission handler maps an accepted package to a bounded
   mutation;
7. production V2 receipt writing remains deliberately disabled and no
   authoritative external-client writer has been selected;
8. the existing reviewed source-ingest routes are separate flows and are not
   external-client package admission.

The current runtime knowledge service has no independent positive evidence for
this route. Live source, exact Git state, tests and CI remain authoritative.

## Binding Product Decision

The first reachable external-client route will not implement a memory-only
`pending`, `pending_review` or similarly named queue. No such durable owner or
public result vocabulary exists in current source.

A successful HTTP response may exist only after one later gate defines and
proves all of the following as one bounded application outcome:

1. the exact domain mutation performed after package admission;
2. the component that owns and durably commits that mutation;
3. the component that owns the corresponding durable receipt;
4. the relationship between mutation commitment and receipt commitment;
5. the bounded failure result when either commitment is unknown or incomplete.

Until those contracts close, the route remains unregistered. Disabled or
requested-but-unready configuration therefore preserves the existing `404`
behavior; it does not add a public disabled-response schema.

This gate does not choose the exact domain mutation. That choice belongs to a
separate bounded mutation-and-receipt ownership gate and is a hard predecessor
of route registration.

## Binding Trust Decisions

The minimum first implementation must preserve these decisions:

- exactly one statically configured external client profile initially;
- the server, never the request body, selects authoritative identity,
  workspace, package scope, permission and trusted public keys;
- the generic API key may remain an outer access guard but never establishes
  external-client identity or authority;
- trusted-key loading, revocation and rotation behavior must be explicit and
  fail closed before route registration;
- replay ownership must be durable, atomic and restart-safe through the
  existing SQLite platform; no process-local set or JSON fallback qualifies;
- no new dependency is authorized;
- no trust root is inferred from transport, actor labels, signatures or
  caller-controlled fields;
- production V2 receipt writing remains disabled until a dedicated exact-scope
  writer gate selects and proves the authoritative owner.

## Required Gate Order

The execution order is binding:

1. `EXTERNAL_CLIENT_ENABLEMENT_0_AUTHORIZATION`
   - one-file docs-only authorization and exact staged scope;
2. `EXTERNAL_CLIENT_IDENTITY_TRUST_CONFIG_0`
   - one server-owned client profile, immutable public-key loading,
     revocation/rotation behavior and fail-closed configuration tests;
3. `EXTERNAL_CLIENT_DURABLE_REPLAY_0`
   - SQLite-backed atomic reservation with restart, concurrency, expiry and
     cross-process evidence;
4. `EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_0`
   - exact domain mutation, durable owner, receipt owner and unknown-outcome
     semantics; production V2 writing requires explicit authorization here or
     in a narrower successor;
5. `EXTERNAL_CLIENT_HTTP_ADAPTER_0`
   - thin HTTP adapter only after all predecessors close; strict body,
     content-type, size, prototype, rate-limit and bounded-response contracts;
6. `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0`
   - disabled absence, spoofing, malformed/oversize input, replay across
     restart and concurrency, handler failure, no-retry, mutation and receipt
     evidence, and an independent external-client smoke;
7. closeout audit and checkpoint reconciliation.

No successor may collapse these evidence classes into one implementation PR.

## HTTP Boundary Requirements

Before route implementation is authorized, the HTTP contract must define:

- exact request body and maximum byte size;
- accepted content type and method behavior;
- rejection of inherited, accessor-backed, symbol, duplicate and unknown
  fields where the JSON boundary can represent them;
- protection against prototype-pollution shapes;
- fixed rate-limit ownership;
- bounded mapping from existing internal failures to HTTP status and response;
- no signature, key material, replay record, authority details or internal
  error leakage;
- no request-body authority selection;
- no automatic retry after an unknown mutation or receipt outcome.

No new public schema, status, error vocabulary or envelope is authorized by
this document.

## Initial Deployment Boundary

The first implementation remains local-only. Internet exposure, TLS or reverse
proxy ownership, multi-instance topology and public deployment are separate
operational gates.

Any replay claim across multiple route processes requires evidence that every
process uses the same durable database and atomic uniqueness boundary. Without
that evidence, external exposure remains blocked.

## Future File Ownership

This docs-only gate authorizes no implementation file. Later task-packs may
consider narrowly scoped ownership such as:

```text
lib/external-client-trust-config.js
lib/external-client-replay-store.js
lib/external-client-admission-use-case.js
lib/external-client-http-admission.js
server.js
server.test.js
lib/external-client-*.test.js
test/external-client-*.test.js
```

The list is planning input, not permission. `server.js` must remain a thin
adapter. Kernel, Graph, receipt modules, schema, package files and deployment
configuration remain separately closed unless an exact later gate proves they
are the minimum owner.

## Stop Conditions

Stop rather than widening scope if a later gate requires:

- body-supplied identity, workspace, key roster, permission or trust root;
- generic API-key-to-client identity inference;
- route registration before identity, durable replay, mutation and receipt
  ownership are green;
- a memory-only review queue or new pending-state vocabulary;
- reuse of the existing source-ingest routes as package admission;
- process-local replay protection for a production claim;
- permissive replay, JSON or key-loading fallback;
- production V2 writing without an explicit authoritative writer gate;
- historical receipt rewrite, rehash or trust-root backfill;
- automatic retry after an unknown outcome;
- a new dependency, public API, schema, version or error vocabulary;
- a change to CLI, local adapters or existing non-package SDK behavior;
- public deployment or multi-client registry scope.

## Acceptance Criteria for This Docs Gate

This gate closes only when:

1. the changed file is exactly this task-pack;
2. the source-definition base and future implementation base are unambiguous;
3. the no-early-route and no-memory-queue decisions are explicit;
4. identity, key operations, durable replay, mutation, receipt and HTTP
   boundaries remain separate gates;
5. route registration is ordered after every required owner;
6. stop conditions and non-claims preserve current fail-closed behavior;
7. `git diff --check` passes;
8. independent read-only review and exact-head CI pass;
9. merge uses the exact reviewed head;
10. clean post-merge docs smoke and checkpoint evidence are recorded.

Tests are not run locally for this docs-only decision gate. Repository-required
CI remains mandatory.

## Non-Claims

This decision does not provide or authorize:

- a reachable or registered external-client route;
- a disabled-route response contract;
- HTTP authentication or transport identity extraction;
- trusted-key storage, rotation or revocation implementation;
- a concrete durable replay store;
- a package-admission mutation or review queue;
- approval, audit or receipt effects;
- production V2 receipt writing or trust-root ownership;
- multi-client registry or multi-instance safety;
- internet exposure, deployment or external interoperability;
- V4 or V5 completion;
- release, package-version or dependency changes.
