# EXTERNAL-CLIENT-ENDPOINT-0 — Default-Closed Contract Authorization

## Plan Check

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact authorization base: `main @ b20810e404ce295c478abf0babfcec6be2a8da74`
- Checkpoint gate: `EXTERNAL_CLIENT_ENDPOINT_0_AUTHORIZATION`
- Predecessors: external-client package gate PR #153, SDK admission PR #154, RTR-5 closeout PR #171
- Mode: pure contract plus adversarial unit test
- Reachable HTTP route: forbidden
- Production package admission handler: forbidden
- Production V2 writer selection: forbidden

## Source-Reality Finding

The exact base contains two external-client foundations:

1. `lib/external-client-package-gate.js` validates a deterministic signed AXIOM package against explicit identity, workspace, expected package, trusted-key scope and Ed25519 signature.
2. `lib/sdk.js` snapshots package bytes and admission authority at client creation and exposes in-process `admitExternalPackage()` only when a handler is explicitly supplied.

The exact base does **not** contain a production external-client HTTP endpoint:

- `server.js` does not import the external-client package gate or SDK admission boundary;
- no route delegates to `admitExternalPackage()`;
- existing `/api/ingest` endpoints are reviewed-source ingest and approval lifecycle surfaces, not external-client package admission;
- current shared API-key handling is not an authoritative external-client identity or workspace mapping;
- no endpoint freshness or replay store exists;
- no production V2 trust-root writer is selected.

Graphify artifacts are absent on this exact base. Live source, tests, exact Git ancestry and CI therefore control this contract.

## Decision

Endpoint-0 adds a **pure, unreachable endpoint descriptor** and exact opt-in configuration parser. It does not modify `server.js`, register a route, parse a request body, call the SDK gate, select a handler, mutate state or issue a receipt.

The descriptor exists to freeze the future endpoint's name, method and default-closed configuration semantics before any production wiring. Even when explicit configuration requests enablement, Endpoint-0 must still report the route as unreachable and authority/mutation as unavailable. Reachability belongs only to later `External Client Enablement-0` work.

## Authorized Files

```text
lib/external-client-endpoint-contract.js
lib/external-client-endpoint-contract.test.js
```

No other file is authorized in the implementation PR.

## Exact Contract

### Version and path

The implementation must export immutable constants:

```text
EXTERNAL_CLIENT_ENDPOINT_CONTRACT_VERSION = external-client-endpoint-0-v1
EXTERNAL_CLIENT_ENDPOINT_PATH = /api/external-client/packages/admit
EXTERNAL_CLIENT_ENDPOINT_METHOD = POST
EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV = HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED
```

This path must not be registered in `server.js` under this gate.

### Configuration vocabulary

The only accepted configuration states are:

| Raw environment value | Normalized state |
| --- | --- |
| absent / `undefined` | `disabled` |
| empty string | `disabled` |
| `0` | `disabled` |
| `false` | `disabled` |
| `1` | `requested` |
| `true` | `requested` |

Whitespace may be trimmed and case may be normalized for the exact boolean words only. Any other non-empty value must throw a typed fail-closed error:

```text
EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID
```

No value may silently enable a route.

### Descriptor shape

The implementation must expose a pure function equivalent to:

```text
buildExternalClientEndpointContract(env)
```

It returns a deeply frozen, null-prototype-safe descriptor with exactly:

```text
contractVersion
path
method
configKey
configurationState
routeReachable
identityAuthorityReady
workspaceAuthorityReady
freshnessReady
replayProtectionReady
mutationAllowed
receiptWriterReady
```

Required values under Endpoint-0:

- `configurationState`: `disabled` or `requested`;
- `routeReachable`: always `false`;
- `identityAuthorityReady`: always `false`;
- `workspaceAuthorityReady`: always `false`;
- `freshnessReady`: always `false`;
- `replayProtectionReady`: always `false`;
- `mutationAllowed`: always `false`;
- `receiptWriterReady`: always `false`.

The descriptor must not contain secrets, trusted keys, package bytes, request bodies, handlers, functions, filesystem paths or mutable references.

### Input ownership

The function may read only the exact configuration key from its supplied environment-like object. It must not read `process.env` implicitly. This keeps authority explicit and unit-testable.

The implementation must reject or ignore prototype/accessor traps without executing attacker-controlled getters. Exact accepted input is a plain object, a null-prototype object, or omitted input. Symbols and unknown keys must not influence the result.

## Required Adversarial Tests

The authorized test file must prove:

1. missing configuration is disabled and every readiness/reachability bit is false;
2. `0` and `false` are disabled;
3. `1` and `true` produce `requested` while route, authority, mutation and writer remain false;
4. invalid values fail with `EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID`;
5. whitespace/case handling is exact and bounded;
6. inherited configuration cannot request enablement;
7. an accessor for the configuration key is rejected or ignored without invoking the getter;
8. symbol and unrelated keys do not affect the descriptor;
9. output and nested values are immutable and carry only the exact approved keys;
10. no runtime module is imported or called: no `server.js`, `kernel.js`, `graph.js`, `lib/sdk.js`, package gate, storage or handler dependency;
11. the production server still has no route path or import for this contract after implementation;
12. the exact implementation diff contains only the two authorized files.

## Required Static Evidence

The implementation PR must include exact-head evidence for:

```bash
node --test lib/external-client-endpoint-contract.test.js
node --test lib/external-client-package-gate.test.js lib/sdk-external-package.test.js
npm test
git diff --check
git status --short
```

A source-scope assertion must verify:

```text
server.js does not contain /api/external-client/packages/admit
server.js does not import external-client-endpoint-contract
server.js does not import external-client-package-gate
server.js does not call admitExternalPackage
```

The test may read `server.js` only as a static artifact. It must not start the HTTP server.

## Error Vocabulary

The module may export exactly one Endpoint-0 error code:

```text
EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID
```

No authentication, authorization, package, freshness, replay, mutation or receipt error vocabulary is authorized here. Those belong to successor gates.

## Compatibility Requirements

- Existing routes and request guards remain byte-for-byte unchanged.
- `/api/ingest` behavior remains unrelated and unchanged.
- Existing SDK and package-gate public behavior remains unchanged.
- No package allowlist or published API expansion is required.
- No environment variable is read at module load.
- Default behavior remains closed when configuration is absent, malformed or attacker-controlled.
- No historical receipt, schema, trust-root, family, reader or export behavior changes.

## Stop Conditions

Stop and record a blocker if implementation requires:

- any `server.js`, `requestGuards.js`, SDK, package-gate, Kernel, Graph or storage change;
- route registration or HTTP request handling;
- request-body parsing or response serialization;
- identity, workspace, key, package, freshness or replay authority decisions;
- a production admission handler;
- mutation, approval, audit or receipt creation;
- production V2 writer selection or enablement;
- package/dependency/configuration-file/release changes;
- a third implementation file;
- weakening any current fail-closed boundary.

A discovered need for any item above requires a separate exact-base scope amendment or the next ordered gate. It is not implicitly authorized.

## Definition of Done

Endpoint-0 closes only when:

1. the exact two authorized files exist;
2. the pure descriptor and configuration parser satisfy the exact contract;
3. default, malformed, inherited, accessor and symbol cases fail closed;
4. `requested` never means reachable, authorized, mutable or writer-ready;
5. static evidence proves no server route or runtime wiring was added;
6. targeted, related, full-suite and exact-head CI evidence pass;
7. exact diff and worktree evidence contain no unrelated change;
8. post-merge checkpoint reconciliation opens only `EXTERNAL_CLIENT_AUTHORITY_0_AUTHORIZATION`.

## Non-Claims

This task-pack does not claim or authorize:

- a reachable external-client endpoint;
- production client authentication or identity mapping;
- authoritative workspace mapping;
- trusted-key loading or revocation;
- request freshness or replay protection;
- package admission execution;
- graph, memory, approval or receipt mutation;
- production V2 receipt writing or trust-root ownership;
- public SDK or package export changes;
- deployment, release or configuration rollout;
- V4 or V5 completion.
