# EXTERNAL-CLIENT-AUTHORITY-0 — Unreachable Admission Authority Authorization

## Plan Check

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact authorization base: `main @ a0b198f4036200feb8bbc98680e502ee8f9c16f3`
- Checkpoint gate: `EXTERNAL_CLIENT_AUTHORITY_0_AUTHORIZATION`
- Predecessors: external-client package gate PR #153, SDK admission PR #154, Endpoint-0 PRs #173/#174
- Mode: fail-closed authority extraction plus in-process SDK wiring
- Reachable HTTP route: forbidden
- `server.js` modification: forbidden
- Production V2 writer selection: forbidden

## Source-Reality Finding

The exact base contains three separate foundations:

1. `lib/external-client-package-gate.js` validates a deterministic signed AXIOM package against caller identity, an authoritative workspace and package expectation, trusted-key scope and Ed25519 signature.
2. `lib/sdk.js` snapshots package bytes and admission options at client creation, invokes the package gate, and calls an explicitly supplied in-process admission handler.
3. `lib/external-client-endpoint-contract.js` reserves `POST /api/external-client/packages/admit` and parses explicit configuration, but every route, authority, freshness, replay, mutation and writer-readiness bit remains false.

The exact base still lacks an authority owner for:

- an exact trusted client identity record;
- explicit admission permission;
- bounded trusted-key validity and revocation state;
- signed-package freshness;
- atomic replay reservation before handler execution.

The current SDK gate proves package possession and bounded key scope, but it does not reject stale signed packages or repeated admission of the same signed package. It also does not require an explicit `package:admit` permission. No production HTTP route exists and no server call path reaches SDK package admission.

Graphify artifacts are absent on this exact base. Live source, tests, exact Git ancestry and CI therefore control this contract.

## Decision

Authority-0 extracts the external-client admission authority responsibility from `lib/sdk.js` into one dedicated module and wires the existing in-process `admitExternalPackage()` path through it. The SDK remains an orchestrator: snapshot package bytes, delegate authority enforcement, then call the already explicit handler.

The authority boundary must fail closed unless all of the following are present and exact:

1. authoritative client subject and kind;
2. authoritative workspace and package identity;
3. exactly one admission permission, `package:admit`;
4. trusted key scope with bounded validity and non-revoked status;
5. signed package `manifest.createdAt` inside the fixed freshness window;
6. an explicit atomic replay owner that reserves the signed package before the handler runs.

This is an in-process authority boundary only. It does not register a route, authenticate an HTTP transport, mutate Graph/Kernel state by itself, or enable a production V2 writer.

## Authorized Files

```text
lib/external-client-authority.js
lib/external-client-authority.test.js
lib/sdk.js
lib/sdk-external-package.test.js
```

No other file is authorized in the implementation PR.

## Required Refactor Boundary

Move the coherent authority-owned responsibilities out of `lib/sdk.js`:

- trusted public-key snapshot and normalization;
- exact client/workspace/package authority snapshot;
- permission snapshot;
- trusted-key validity and revocation snapshot;
- trusted clock binding;
- atomic replay-owner binding;
- gate invocation plus freshness, permission and replay decision.

`lib/sdk.js` may preserve `snapshotPackageAdmissionAuthority` as a compatibility facade, but its implementation must delegate to the new authority module. The SDK may continue to own deterministic package-byte snapshotting and handler invocation ordering.

Do not duplicate the package-gate signature or scope logic. The new authority module must call `enforceExternalClientPackage()` and then apply the additional authority checks to its verified result.

## Exact Authority Contract

### Version and fixed bounds

The implementation must export immutable constants:

```text
EXTERNAL_CLIENT_AUTHORITY_VERSION = external-client-authority-0-v1
EXTERNAL_CLIENT_ADMISSION_PERMISSION = package:admit
EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS = 300000
EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS = 30000
EXTERNAL_CLIENT_REPLAY_TTL_MS = 600000
```

These bounds are not caller-configurable under Authority-0.

### Authoritative configuration

The SDK options used to create an external-package client must include:

```text
expectedIdentitySubject
expectedIdentityKind
expectedWorkspaceId
expectedPackageId
permissions
trustedKeys
clock
replayStore
packageAdmissionHandler
```

Requirements:

- `expectedIdentitySubject`, `expectedIdentityKind`, `expectedWorkspaceId` and `expectedPackageId` are non-empty exact strings after trimming;
- `permissions` contains exactly `package:admit`, with no unknown, duplicate, inherited, accessor-backed or symbol permission;
- `clock` is an explicitly supplied trusted function returning a finite Unix epoch millisecond value;
- `replayStore` exposes an explicitly owned atomic `reserve(record)` function;
- `packageAdmissionHandler` remains separately required by the SDK after authority allows;
- no value is read implicitly from `process.env`, global request state or `server.js`.

### Trusted-key authority

Every trusted-key entry admitted by Authority-0 must snapshot:

```text
publicKey
workspaceId
packageIds
identitySubjects
identityKinds
notBefore
notAfter
revoked
```

Requirements:

- existing public-key snapshot protections remain intact;
- `notBefore` and `notAfter` are required valid ISO-8601 instants with `notBefore < notAfter`;
- `revoked` must be exactly `false`; missing, truthy, inherited or malformed values fail closed;
- the verified package signing key ID must remain in the existing package-gate scope and in its validity interval;
- key validity is checked against the trusted clock and the signed package creation time;
- no private-key material is accepted;
- no silent unlimited-lifetime key fallback is permitted.

### Signed-package freshness

Freshness derives only from the already signed and validated `package.manifest.createdAt` value.

After package-gate success:

1. parse `manifest.createdAt` as an exact finite instant;
2. reject an invalid instant;
3. reject a package older than `EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS`;
4. reject a package more than `EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS` ahead of the trusted clock;
5. do not accept caller-supplied `issuedAt`, `expiresAt`, nonce or freshness override fields;
6. do not rewrite or re-sign the package.

### Identity, workspace, package and permission binding

The verified gate result must exactly match the snapshotted authority:

```text
identity.subject == expectedIdentitySubject
identity.kind == expectedIdentityKind
workspaceId == expectedWorkspaceId
packageId == expectedPackageId
signature.keyId is the exact verified trusted key
permission == package:admit
```

Transport labels, route configuration, actor names, local reachability or handler presence must not imply authority.

### Replay ownership

The replay key must be deterministic and derived only from verified signed evidence:

```text
authorityVersion
identity subject and kind
workspaceId
packageId
packageHash
trustedKeyId
signed package createdAt
permission
```

The key may be encoded as a canonical SHA-256 digest with a stable Authority-0 prefix.

Before any admission handler runs, the authority module must call the bound atomic replay owner with a deeply frozen, secret-free record containing at least:

```text
replayKey
identitySubject
identityKind
workspaceId
packageId
packageHash
trustedKeyId
permission
createdAt
reservedAt
expiresAt
```

Required semantics:

- `expiresAt = reservedAt + EXTERNAL_CLIENT_REPLAY_TTL_MS`;
- exact `{ reserved: true }` is the only success result;
- `{ reserved: false }`, `false`, duplicate evidence or an explicit existing record produces a typed replay error;
- thrown, rejected, missing or malformed replay-owner behavior produces a typed replay-reservation error;
- the reservation occurs after signature, scope, identity, key-validity and freshness checks but before handler execution;
- once reserved, a later handler failure does not release or silently retry the replay key;
- Authority-0 does not implement storage; it requires and proves the atomic owner contract.

### Authority result

The successful authority result must be deeply frozen, secret-free and exact-shape. It must include only bounded verified evidence such as:

```text
ok
decision
authorityVersion
permission
identity
workspaceId
packageId
packageHash
trustedKeyId
createdAt
reservedAt
expiresAt
replayKey
gate
authorityReceipt
```

`authorityReceipt` must not claim a production Trust Receipt or production V2 trust root. It is a bounded in-process admission-authority receipt only.

The SDK handler context may add this authority result or bounded fields from it. It must not expose public-key material, replay-store references, clock functions, handlers or mutable authority configuration.

## Required Error Vocabulary

The new module must export one frozen error map containing exact Authority-0 codes for at least:

```text
EXTERNAL_CLIENT_AUTHORITY_REQUIRED
EXTERNAL_CLIENT_AUTHORITY_IDENTITY_MISMATCH
EXTERNAL_CLIENT_AUTHORITY_PERMISSION_REQUIRED
EXTERNAL_CLIENT_AUTHORITY_KEY_INVALID
EXTERNAL_CLIENT_AUTHORITY_KEY_REVOKED
EXTERNAL_CLIENT_AUTHORITY_CREATED_AT_INVALID
EXTERNAL_CLIENT_AUTHORITY_STALE
EXTERNAL_CLIENT_AUTHORITY_FUTURE_DATED
EXTERNAL_CLIENT_AUTHORITY_CLOCK_INVALID
EXTERNAL_CLIENT_AUTHORITY_REPLAY_OWNER_REQUIRED
EXTERNAL_CLIENT_AUTHORITY_REPLAY_DETECTED
EXTERNAL_CLIENT_AUTHORITY_REPLAY_RESERVATION_FAILED
```

Existing package-gate and SDK handler errors remain unchanged and control their existing boundaries.

## Required Ordering

The in-process SDK admission order must be exactly:

1. snapshot deterministic package bytes;
2. enforce existing package format, expected identity/workspace/package, trusted-key scope and Ed25519 signature;
3. enforce exact authority identity and permission;
4. enforce trusted-key validity and non-revocation;
5. enforce signed-package freshness using the trusted clock;
6. atomically reserve replay evidence;
7. construct frozen handler context;
8. require the explicit handler;
9. invoke the handler once;
10. return frozen gate, authority and admission evidence.

No handler, Kernel, Graph, storage mutation or receipt writer may run before step 6 succeeds.

## Required Adversarial Tests

The new authority test and updated SDK test must prove at least:

1. exact identity, workspace, package, key and `package:admit` permission allow one fresh signed package;
2. the replay owner is called exactly once before the handler;
3. a second admission of the same signed package is rejected before the handler;
4. missing or malformed authority configuration fails at client creation;
5. identity subject or kind mismatch fails after signature verification and before replay reservation;
6. missing, unknown, duplicate, inherited, accessor-backed or symbol permission fails closed;
7. invalid, missing, reversed, not-yet-valid or expired key interval fails closed;
8. `revoked: true`, missing revocation state or accessor-backed revocation fails closed;
9. stale, invalid and excessively future-dated signed `manifest.createdAt` values fail closed;
10. caller freshness or replay override fields have no effect;
11. missing replay owner fails before handler execution;
12. replay duplicate result produces the exact replay error;
13. replay-owner throw, rejection or malformed result produces the exact reservation error;
14. handler failure after reservation does not release or repeat reservation;
15. mutable option, key, permission, clock and replay-owner descriptors cannot replace snapshotted authority;
16. private-key material and normalized key-ID collisions remain rejected;
17. handler receives frozen verified package and bounded frozen authority context;
18. existing invalid-signature cases still fail before authority or handler side effects;
19. `server.js` still has no Endpoint-0 route, authority import, package-gate import or SDK admission call;
20. exact diff contains only the four authorized files.

## Compatibility Requirements

- Existing package format and signature bytes remain unchanged.
- Existing package-gate API and error behavior remain unchanged.
- `createAxiomClient()` public method names remain unchanged.
- Existing `admitExternalPackage()` becomes intentionally stricter and fail-closed; clients must supply the exact Authority-0 options to use that method.
- Existing non-package SDK methods remain unchanged.
- `snapshotPackageAdmissionAuthority` remains exported as a compatibility facade if currently public.
- Existing Endpoint-0 descriptor remains byte-for-byte unchanged.
- Existing `server.js`, `/api/ingest`, request guards, Kernel, Graph and receipt behavior remain unchanged.
- No environment variable is read at module load or authority decision time.
- No package, dependency, export-map, version or release change.

## Required Static and Runtime Evidence

The implementation PR must include exact-head evidence for:

```bash
node --test lib/external-client-authority.test.js
node --test lib/external-client-package-gate.test.js lib/sdk-external-package.test.js lib/external-client-endpoint-contract.test.js
npm test
git diff --check
git status --short
```

Static assertions must prove:

```text
server.js does not contain /api/external-client/packages/admit
server.js does not import external-client-authority
server.js does not import external-client-package-gate
server.js does not call admitExternalPackage
external-client-authority.js does not import server.js, kernel.js, graph.js or storage
```

## Stop Conditions

Stop and record a blocker if implementation requires:

- any file outside the four authorized paths;
- `server.js`, request-guard, Kernel, Graph, receipt, package-format or storage modification;
- route registration, HTTP parsing or response serialization;
- a new dependency or persistence implementation;
- caller-controlled freshness, permission, key validity or replay success;
- releasing a replay reservation after handler failure;
- a permissive fallback when authority, clock or replay owner is absent;
- production V2 writer or trust-root ownership selection;
- historical receipt rewrite, backfill or rehash;
- release, deployment, package-version or configuration-file changes;
- weakening any existing package-gate, SDK snapshot or Endpoint-0 fail-closed boundary.

A discovered need for any item above requires a separate exact-base scope amendment. It is not implicitly authorized.

## Definition of Done

Authority-0 closes only when:

1. the exact four authorized files contain the extracted authority module, adversarial tests and thin SDK delegation;
2. identity, workspace, package, permission and trusted-key authority are snapshotted and exact;
3. signed-package freshness and fixed key validity are enforced from verified evidence;
4. atomic replay reservation succeeds before handler execution and duplicate/error paths fail closed;
5. targeted, related, full-suite and exact-head CI evidence pass;
6. exact diff and worktree evidence contain no unrelated change;
7. static evidence proves no reachable route or server wiring was added;
8. adversarial review confirms no authority can be inferred from transport, route configuration or handler presence;
9. post-merge checkpoint reconciliation opens only `EXTERNAL_CLIENT_ADVERSARIAL_0_AUTHORIZATION`.

## Non-Claims

This task-pack does not claim or authorize:

- a reachable external-client endpoint;
- HTTP authentication or transport identity extraction;
- a concrete durable replay-store implementation;
- Graph, Kernel, memory, approval, audit or receipt mutation;
- production V2 receipt writing or trust-root ownership;
- historical V1 rewrite, trust-root backfill or rehash;
- public configuration rollout;
- release, deployment, package-version or dependency change;
- V4 or V5 completion.
