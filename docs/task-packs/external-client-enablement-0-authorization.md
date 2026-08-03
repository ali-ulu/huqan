# EXTERNAL-CLIENT-ENABLEMENT-0 - Authorization

## Gate Identity

- Repository: `ali-ulu/huqan`
- Mode: docs-only authorization
- Scope-definition base: `main` at
  `109e988f64ba23b65a8b8e128d5c207b575d6843`
- Governing predecessor:
  `docs/task-packs/external-client-enablement-0-use-case-decision.md`
- Required predecessor checkpoint:
  `EXTERNAL_CLIENT_ENABLEMENT_0_USE_CASE_DECISION_CLOSEOUT_AUDIT_GREEN`
- Authorized successor after this gate closes:
  `EXTERNAL_CLIENT_IDENTITY_TRUST_CONFIG_0`

The scope-definition base records the source state for this authorization. It
is not an implementation base. Every implementation gate requires a separately
authorized exact post-merge `main` SHA.

## Authorization Boundary

This gate authorizes no runtime, test, schema, package, server, deployment or
route implementation.

The only allowed changed file is:

```text
docs/task-packs/external-client-enablement-0-authorization.md
```

No future implementation begins from this document alone. Each successor needs
its own exact-base authorization, narrow file scope, source-reality review,
tests, independent review, exact-head merge and closeout.

## Binding Ownership Decisions

The first external-client path must preserve these decisions:

- Exactly one server-owned, statically configured external-client profile is
  permitted initially.
- The request body never selects identity, workspace, package scope,
  permission, trusted keys or trust root.
- The generic server API key may remain an outer access guard but does not
  establish external-client authority.
- Trusted public-key loading, key rotation and revocation are server-owned
  operations with explicit fail-closed behavior.
- Replay reservation is owned by a durable SQLite-backed boundary; process
  memory, JSON fallback and best-effort replay protection do not qualify.
- The existing Graph SQLite mutation journal is not the external-client replay
  reservation owner and does not prove pre-mutation reservation, TTL expiry or
  external-client ownership.
- The admitted domain mutation and durable receipt must have one explicitly
  selected application owner before any HTTP route can be registered.
- No request may create a production V2 receipt until a separately authorized
  writer gate defines and proves the authoritative receipt owner.
- No new dependency, public schema, public error vocabulary, version or
  package contract is authorized.

## Binding Successor Sequence

The following sequence is mandatory and may not be collapsed:

1. `EXTERNAL_CLIENT_IDENTITY_TRUST_CONFIG_0`
   - Define one static server-owned client profile.
   - Define immutable trusted-key loading, revocation and rotation behavior.
   - Prove malformed, missing, revoked and unknown configuration fails closed.
   - No HTTP route, replay store, mutation or receipt writing.

2. `EXTERNAL_CLIENT_DURABLE_REPLAY_0`
   - Implement SQLite-backed atomic external-client replay reservation.
   - Prove restart, expiry, concurrency and cross-process behavior.
   - No memory-only replay ownership and no HTTP route.

3. `EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_0`
   - Select the exact bounded admitted mutation.
   - Select the durable mutation owner and receipt owner.
   - Define unknown or incomplete outcome behavior without automatic retry.
   - Keep production V2 receipt writing disabled unless separately authorized.

4. `EXTERNAL_CLIENT_HTTP_ADAPTER_0`
   - Add only a thin HTTP adapter after all preceding gates close green.
   - The adapter may authenticate, normalize, call the bounded use case and map
     existing bounded results; it may not own trust, replay, mutation or receipt
     semantics.

5. `EXTERNAL_CLIENT_ROUTE_ADVERSARIAL_0`
   - Prove disabled-route absence, spoofing rejection, malformed and oversized
     inputs, prototype-pollution rejection, replay across restart and
     concurrency, handler failure, no-retry behavior, mutation/receipt evidence
     and an independent external-client smoke.

6. `EXTERNAL_CLIENT_ENABLEMENT_0_CLOSEOUT_AUDIT`
   - Verify lineage, exact scopes, live route boundary, CI, fail-closed behavior
     and all non-claims before recording closeout.

## Route Boundary

Until every required predecessor closes green:

```text
POST /api/external-client/packages/admit
```

must remain unregistered and therefore preserve the existing `404` behavior.

No disabled-route response schema is added. A requested configuration value does
not make the route reachable, ready or partially available.

A memory-only `pending`, `pending_review` or equivalent queue is forbidden.
No request may be accepted for later processing without a selected durable
mutation and receipt owner.

## HTTP Preconditions

The future adapter gate must define before implementation:

- exact request body and byte limit;
- accepted method and content type;
- rejection of unknown, inherited, accessor-backed and prototype-pollution
  shapes where representable at the JSON boundary;
- fixed rate-limit ownership;
- bounded internal-failure to HTTP mapping;
- no signature, public-key roster, replay record, trust configuration or
  internal error leakage;
- no request-body authority selection;
- no automatic retry after an unknown mutation or receipt result.

## Stop Conditions

Stop and return `EXTERNAL_CLIENT_ENABLEMENT_0_BLOCKED_CONTRACT_CONFLICT` if a
successor requires:

- identity, workspace, key roster, permission or trust root supplied by a
  caller;
- a generic API key to imply external-client identity;
- route registration before durable trust, replay, mutation and receipt
  ownership are proven;
- a process-local or JSON replay fallback;
- a memory-only pending queue or new pending-state vocabulary;
- a new dependency, public API, schema, error vocabulary, version or package
  contract;
- production V2 receipt writing without a separately authorized owner;
- reuse of reviewed source-ingest paths as package admission;
- automatic retry after unknown mutation or receipt outcome;
- multi-client registry, public deployment, TLS, proxy or multi-instance scope.

## Acceptance Criteria

This docs-only gate closes only when:

1. exactly this task-pack changes;
2. the scope-definition base and future implementation bases are unambiguous;
3. the static server-owned profile and trusted-key operations are bound to the
   first implementation gate;
4. SQLite durable replay precedes mutation and receipt ownership;
5. the HTTP adapter is last and remains thin;
6. the route-absent `404` and no-memory-queue boundaries are explicit;
7. no public schema, error vocabulary, dependency or runtime behavior is
   authorized;
8. `git diff --check`, independent review, exact-head CI, merge and clean
   post-merge docs smoke pass.

## Non-Claims

This authorization does not provide or authorize:

- a registered or reachable external-client route;
- external-client authentication or transport identity extraction;
- a trusted-key store, replay store, mutation handler or receipt writer;
- production V2 receipt writing;
- a pending queue or asynchronous review workflow;
- multi-client, multi-instance or public deployment behavior;
- changes to CLI, local adapters, existing SDK behavior, V4 or V5 claims.
