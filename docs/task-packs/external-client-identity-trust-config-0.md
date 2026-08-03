# EXTERNAL-CLIENT-IDENTITY-TRUST-CONFIG-0 - Scope Definition

## Gate Identity

- Repository: `ali-ulu/huqan`
- Mode: docs-only scope definition
- Scope-definition base: `main` at
  `a3557dde9022c2d238caad170dfe19645b3b8200`
- Governing predecessor:
  `docs/task-packs/external-client-enablement-0-authorization.md`
- Required predecessor checkpoint:
  `EXTERNAL_CLIENT_ENABLEMENT_0_AUTHORIZATION_CLOSEOUT_AUDIT_GREEN`
- Authorized successor after this gate closes:
  `EXTERNAL_CLIENT_IDENTITY_TRUST_CONFIG_0_IMPLEMENTATION`

The scope-definition base records the source state used to define this gate. It
is not the implementation base. Implementation requires a separately
authorized exact post-merge `main` SHA.

## Allowed Change

This gate may add only:

```text
docs/task-packs/external-client-identity-trust-config-0.md
```

It authorizes no runtime, test, package, server, route, replay, mutation,
receipt, deployment or public configuration change.

## Source Reality

At the scope-definition base:

1. `snapshotExternalClientAuthority()` already accepts a complete injected
   authority object and creates an immutable in-process snapshot;
2. the authority binds exact identity subject and kind, workspace, package,
   the single `package:admit` permission, trusted-key scope, validity interval,
   trusted clock and atomic replay owner;
3. trusted-key entries accept only bounded own data properties and reject
   revoked, malformed, inherited, accessor-backed, symbol and unknown data;
4. more than one active key ID is already supported, but no maximum roster
   size is defined;
5. a `revoked: true` entry rejects the complete authority snapshot rather than
   filtering only that key;
6. the supported package signature algorithm is `ed25519`;
7. no server-owned external-client profile loader, environment vocabulary,
   file schema, watcher, network resolver or hot-reload owner exists;
8. `server.js` has no external-client authority import or route;
9. the V5 trusted-key resolver is a separate bounded verification contract and
   is not an external-client configuration or lifecycle owner; and
10. the route, durable replay-reservation owner, admitted mutation and
    production receipt writer remain absent.

## Binding Carrier Decision

The first implementation uses only an explicitly injected, internal
server-composition object.

It must not read:

- environment variables;
- files or JSON configuration;
- network, provider or key-store services;
- request bodies, headers or query parameters;
- process-global mutable registries; or
- system time.

This internal carrier is not a public configuration schema. A deployment
source for constructing it remains a later, separately authorized composition
decision.

## Bounded Profile Contract

The internal input is one exact profile:

```text
profileVersion
expectedIdentitySubject
expectedIdentityKind
expectedWorkspaceId
expectedPackageId
permissions
trustedKeys
```

The profile must require:

- exact version `external-client-trust-config-0-v1`;
- non-empty exact identity subject and kind;
- non-empty exact workspace and package IDs;
- exactly one permission, `package:admit`; and
- at least one active trusted-key entry.

Each trusted-key entry must contain only:

```text
publicKeySpkiDer
workspaceId
packageIds
identitySubjects
identityKinds
notBefore
notAfter
revoked
```

The key material contract is:

- `publicKeySpkiDer` is an exact 44-byte `Buffer` or `Uint8Array` containing an
  Ed25519 public SPKI DER value;
- the implementation defensively copies visible bytes before parsing;
- the resulting key must be a public Ed25519 `crypto.KeyObject`;
- private keys, PEM, JWK, seed material and any secret-bearing alternative are
  rejected rather than normalized; and
- no input byte object or mutable profile object may remain aliased into the
  returned snapshot.

Key scope and time values must preserve the existing Authority-0 contract:

- key `workspaceId` equals the exact profile workspace;
- each key `packageIds`, `identitySubjects` and `identityKinds` list contains
  exactly one value, equal respectively to the profile package, identity
  subject and identity kind;
- scope lists are non-empty unique own strings;
- `notBefore` and `notAfter` are canonical ISO timestamps;
- `notBefore` is strictly before `notAfter`; and
- `revoked` must be exactly `false`.

Unknown, inherited, accessor-backed, non-enumerable, symbol and Proxy-hostile
fields fail closed. The complete profile fails if any entry is malformed.

## Rotation And Revocation

The first implementation is restart-only:

- no watcher, reload callback or mutable live registry exists;
- rotation is represented by constructing a new profile snapshot containing
  both old and new active key IDs for a bounded overlap period;
- this gate does not invent a maximum key count because current source defines
  none;
- revocation is activated by removing the old key from a new profile and
  restarting composition; and
- retaining `revoked: true` in a profile remains a fail-closed configuration
  error, matching current authority behavior.

The snapshot primitive does not read a clock. Trusted evaluation time remains
an explicitly injected dependency of the later authority/replay composition.

## Future Implementation Scope

Only a separate exact-base implementation authorization may change:

```text
lib/external-client-trust-config.js
lib/external-client-trust-config.test.js
```

The implementation must be a pure bounded materializer. It may use only
`node:crypto` and existing internal constants or errors. It must not construct
an Authority-0 snapshot because clock and replay ownership are not part of this
gate.

Package allowlist and tarball changes are deferred until a production runtime
caller needs the module. That later gate must add the module to `package.json`
and prove packed-install behavior before any published runtime imports it.

## Required Test Matrix

The implementation test owner must prove:

- one valid profile produces a frozen, secret-free, deterministic snapshot;
- Buffer and offset `Uint8Array` inputs use only visible bytes and are copied;
- later mutation of every input level and key bytes cannot change output;
- exact root and key-entry allowlists reject unknown and hostile properties;
- missing, empty, duplicate or normalization-colliding IDs fail closed;
- permission is exactly `package:admit`;
- workspace, package and identity scope uses exact singleton equality with the
  profile root and cannot be widened with extra values;
- non-Ed25519, non-public, wrong-length, malformed and private key material is
  rejected;
- reversed, equal and non-canonical validity intervals fail closed;
- `revoked: true`, missing revoked state and malformed roster entries fail the
  complete profile;
- multiple active key IDs are preserved for restart-only rotation;
- removing an old key from a new snapshot makes it absent without mutating the
  old snapshot;
- no environment, filesystem, network, system-clock or global-state access;
  and
- no route, replay, mutation, receipt or Authority-0 construction side effect.

Related Authority, package, SDK and endpoint-contract tests must remain green.

## Stop Conditions

Stop with
`EXTERNAL_CLIENT_IDENTITY_TRUST_CONFIG_0_BLOCKED_CONTRACT_CONFLICT` if the
implementation requires:

- environment names, a file schema or network/key-store lookup;
- request-controlled identity, scope, permission, keys or trust root;
- hot reload, live mutation or multi-client registry behavior;
- a maximum active-key count not already defined by source;
- filtering `revoked: true` entries instead of rejecting the profile;
- the V5 trusted-key resolver or its test-key semantics;
- a new dependency, public API, public error vocabulary, version or package
  contract;
- changes to `server.js`, `kernel.js`, `graph.js`, SDK, route or endpoint
  descriptor;
- replay, mutation, receipt or production V2 writer ownership; or
- deployment, TLS, proxy or multi-instance behavior.

## Acceptance Criteria

This docs-only gate closes only when:

1. exactly this task-pack changes;
2. the internal injected-object carrier decision is unambiguous;
3. key material and lifecycle behavior are bounded and fail closed;
4. implementation and forbidden file scopes are exact;
5. route, replay, mutation, receipt and deployment remain downstream;
6. no public schema, error vocabulary or dependency is invented; and
7. `git diff --check`, independent review, exact-head CI, merge and clean
   post-merge docs smoke pass.

## Non-Claims

This scope definition does not provide or authorize:

- a production profile source or deployment configuration;
- a server-owned loader or server composition;
- a registered or reachable route;
- a durable replay-reservation store;
- an admitted mutation or receipt writer;
- hot reload, dynamic rotation or network key resolution;
- a public config schema, public API or package surface; or
- V4 or V5 completion.
