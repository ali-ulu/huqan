# ADR-010 - Production External-Client Boundary Selection

## Status

Accepted architecture decision

Implementation status: Not implemented (decision only)

Supersedes nothing. Fills the open contract left by
`ADR-008-trust-root-boundaries.md`, section "External Endpoint Boundary".

## Context

ADR-008 established two trust roots and required that a future production
boundary for `external_verified_client` identify eight specific things before
implementation. It deliberately did not select that boundary. `TB-A6`
("Connector identity and package enforcement") has been blocked on exactly that
missing selection: without it, current CLI and local-adapter behavior cannot be
moved safely, and no production caller can be authorized.

The blocking condition is a decision, not missing code. A source review of the
current tree shows the external-client stack is already built and fail-closed:

| Concern | Module | Evidence |
| --- | --- | --- |
| Authoritative admission | `lib/external-client-authority.js` | `EXTERNAL_CLIENT_AUTHORITY_VERSION = 'external-client-authority-0-v1'` (`:10`); two-phase snapshot/enforce (`:160`, `:281`) |
| Package and signature gate | `lib/external-client-package-gate.js` | `EXTERNAL_CLIENT_PACKAGE_GATE_VERSION = 'tb-a6-v1'` (`:7`); `SUPPORTED_SIGNATURE_ALGORITHM = 'ed25519'` (`:8`) |
| Trusted-key materialization | `lib/external-client-trust-config.js` | `EXTERNAL_CLIENT_TRUST_CONFIG_VERSION = 'external-client-trust-config-0-v1'` (`:9`); `EXTERNAL_CLIENT_MAX_TRUSTED_KEYS = 2` (`:10`) |
| Reserved endpoint shape | `lib/external-client-endpoint-contract.js` | `POST /api/external-client/packages/admit` (`:4-5`); opt-in key `AXIOM_EXTERNAL_CLIENT_ENDPOINT_ENABLED` (`:6`) |
| Transport envelope | `lib/external-client-http-adapter.js` | request body constrained to exactly `{package, signature}` |
| Admission entry | `lib/sdk.js` | `snapshotPackageAdmissionAuthority` (`:71`), `admitExternalClientPackage` (`:97`) |

Every one of these modules is reachable today only from its own tests and from
`test/helpers/external-client-route-fixture.js`. No production surface calls
them. Three tests currently assert that absence as an invariant
(`lib/external-client-authority.test.js`, `lib/external-client-endpoint-contract.test.js`,
`test/external-client-route-adversarial.test.js`).

This ADR selects the boundary. It does not build it.

## Decision

### 1. Authoritative admission handler

The production external-client boundary is the reserved route
`POST /api/external-client/packages/admit`, registered in `server.js` only
when explicitly enabled, delegating to the SDK entry point
`admitExternalPackage`. No other surface is authorized to admit an external
package.

The route is not the authority. `enforceExternalClientAuthority` remains the
authority; the route is only its transport. A second transport may be added
later only by amending this ADR.

### 2. Source of client identity

Client identity and workspace are **server-owned configuration, never derived
from the request**. The transport injects `identity` and `workspaceId` from the
static trust profile after the request is parsed; the request envelope stays
exactly `{package, signature}` so a caller cannot supply, override, or probe
them.

This preserves ADR-008 invariant 4: identity, workspace, package, signature and
trusted-key failures all occur before the admission handler and before any
mutation. It also means possession of a transport connection conveys no
identity, which is what ADR-008 rejected reusing local-operator admission to
avoid.

### 3. Exact workspace binding

Workspace binding is the existing four-way intersection already enforced by the
gate: request workspace, authority `expectedWorkspaceId`, `manifest.workspaceId`,
and the trusted key's own scope must all agree, and `manifest.createdBy` must
equal the identity subject. Any disagreement is fail-closed.

### 4. Signed-package transport and limits

Ed25519 over the canonical `stableStringify` serialization, unchanged. Package
validation tolerates zero warnings. The `{package, signature}`-only envelope and
existing size and depth bounds are retained as-is.

### 5. Trusted public-key provisioning and lifecycle

Provisioning is the existing static in-process profile via
`materializeExternalClientTrustConfig`: **one authorized client, at most two
keys** (one active plus one rotation), each key scoped to exactly one
workspace, package, identity subject and identity kind.

Rotation is performed by materializing a new profile and restarting the
process. Revocation is `revoked: true` on the key entry, which the authority
rejects at snapshot time.

A multi-client registry, a network key resolver, and dynamic runtime
provisioning are **explicit non-goals of this ADR** and remain blocked.

### 6. Replay and freshness rules

Unchanged from the implemented authority, and ratified here as the production
contract:

| Rule | Constant | Value |
| --- | --- | --- |
| Maximum package age | `EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS` | `300000` |
| Maximum future skew | `EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS` | `30000` |
| Replay reservation TTL | `EXTERNAL_CLIENT_REPLAY_TTL_MS` | `600000` |
| Admission permission | `EXTERNAL_CLIENT_ADMISSION_PERMISSION` | `package:admit` |

Replay reservation is awaited before the handler runs. A reservation that does
not return exactly `{reserved: true}` is a failure, not a pass.

### 7. Mutation, audit, receipt and error ownership

`lib/external-client-mutation-receipt-owner.js` owns the durable mutation and
its receipt. Per
`docs/task-packs/external-client-enablement-0-use-case-decision.md`, a success
response may exist only once the exact domain mutation, its durable owner, the
receipt owner, the mutation-to-receipt relationship, and the bounded failure
result are all defined and proven. No memory-only pending queue is permitted.

### 8. Configuration exposure while disabled

While disabled, the configuration exposes **no route at all**. The path returns
the same generic `404 {error: 'Not found'}` as any unknown path, in both the
`disabled` and `requested` configuration states, and is indistinguishable from
a server that has no such feature.

`configurationState: 'requested'` expresses intent only. It does not make the
route reachable. Reachability requires the separate authorization named below.

## What this ADR does not do

This ADR performs no wiring. `server.js` is unchanged, the three tests
asserting server ignorance of the route remain valid and unmodified, and the
route remains unregistered.

Making the route reachable is `EXTERNAL-CLIENT-ENABLEMENT-0` in ADR-008's
required sequence and needs its own exact-base authorization, independent
review, and closeout evidence. This ADR is its input, not its approval.

Consequently this ADR **does not close `TB-A6`**. It removes `TB-A6`'s stated
blocker ("production external-client boundary must be selected; authoritative
handler, identity/workspace binding, signed-package transport and trusted-key
provisioning contract must be defined"). The remaining `TB-A6` acceptance
criteria that require a production caller — receipt-visible identity and scope
on a real path, per-connector positive and negative runtime evidence — stay
open.

## Rejected Alternatives

### Register the route now, in the same change as this decision

Rejected. ADR-008 invariant 5 and its required sequence both make enablement a
separately authorized step. Deciding and enabling in one change would remove
the review gate that the default-closed design exists to provide, and would
require inverting three passing invariant tests in the same commit that
introduces the decision they constrain.

### Run external-client admission as a separate process or binary

Rejected for now, not on merit. It is the stronger isolation story and remains
available as a future amendment. It is rejected at this gate because it adds a
new deployment surface and process lifecycle with no current external client to
justify them, while the HTTP adapter, endpoint contract and adversarial route
fixture are already written against the in-server route shape.

### Derive client identity from the request or from an API key

Rejected. ADR-008 rejected collapsing a cryptographic trust boundary into
possession of a transport connection. An API-key-to-identity mapping would
reintroduce exactly that: a leaked key would convey identity, and the signed
package would no longer be the thing that establishes the trust root. This may
be revisited only alongside a multi-client registry decision, and only if the
key material is bound to the signing key rather than replacing it.

### Make the CLI the first real external-client caller

Rejected. It violates ADR-008 invariant 2. The CLI runs under `local_operator`
by design; routing it through the external gate would either require the local
operator to sign its own local command, which adds no independent trust root,
or collapse the two trust roots into one. The `cli.js` mutating-surface gap
tracked separately is a local-admission parity issue, not an external-client
issue.

### Adopt the parallel V5 signing and trusted-key work as the provisioning story

Rejected at this gate. The V5 verification and shared-trust-package scope
documents describe an overlapping trusted-key resolver. Reconciling two answers
to the same question is itself a decision gate, and folding an unimplemented
V5 track into a Trust Boundary decision would make this ADR depend on a phase
that has not passed its own entry audit.

## Stop Conditions

Stop before implementation if any step requires:

- enabling the route by default, or making `requested` imply reachable;
- deriving identity or workspace from request-controlled input;
- accepting more than one client or more than two keys under this ADR;
- a memory-only pending or review queue behind a success response;
- relaxing the zero-warning package validation, the Ed25519-only rule, or the
  freshness and replay constants recorded above;
- changing CLI, local-adapter, or existing `/api/ingest` behavior;
- treating this decision as production enforcement evidence.

## Non-Claims

This ADR does not claim or implement:

- a reachable production external-client endpoint;
- production connector enforcement or runtime evidence for `TB-A6`;
- trusted-key rotation automation, network resolution, or a multi-client
  registry;
- receipt schema changes;
- CLI, GitHub, or Markdown external ingest enablement;
- V4 or V5 phase completion.
