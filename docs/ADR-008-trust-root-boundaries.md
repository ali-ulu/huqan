# ADR-008 - Trust-Root Boundaries

## Status

Accepted architecture decision

Implementation status: Partial

## Context

HUQAN has two materially different ingestion authorities:

- local CLI and local adapters run under an operator who already controls the
  process, filesystem, configuration, and persistence environment;
- an external client runs outside that local authority and must establish its
  identity and package authority cryptographically before any bounded
  admission handler is invoked.

These paths are not interchangeable implementations of one trust boundary.
Requiring a local operator to sign its own local command does not add an
independent trust root. Allowing an external client to inherit local-operator
semantics would remove the boundary that its signature is intended to prove.

The bounded external package gate and SDK admission surface exist in current
source. No production HTTP, CLI, MCP, GitHub, or Markdown connector currently
calls that SDK admission surface. Production external-client enforcement is
therefore not implemented.

## Decision

HUQAN recognizes two distinct trust roots:

| Trust root | Authority | Required evidence | Boundary |
| --- | --- | --- | --- |
| `local_operator` | The operator controlling the local process and persistence environment | Existing local admission, provenance, audit, and mutation contracts | CLI and explicitly local adapters only |
| `external_verified_client` | A remote client whose machine and runtime are not locally trusted | Bounded client identity, exact workspace binding, signed package evidence, trusted public-key authority, and fail-closed admission | A separately authorized external-client endpoint only |

The following invariants are binding:

1. Existing CLI and local-adapter behavior is not migrated to the external
   package gate merely to unify code paths.
2. An external client never falls back to `local_operator` semantics.
3. A local invocation never claims `external_verified_client` without the
   complete external verification boundary.
4. External identity, workspace, package, signature, and trusted-key failures
   occur before the admission handler and before mutation.
5. The external endpoint is absent or unreachable by default. It may become
   reachable only through an explicit opt-in configuration defined by a later
   implementation contract.
6. Existing `/api/ingest` fail-closed behavior for GitHub and Markdown is not
   relaxed by this decision.
7. A gate existing in a library is not evidence that a production caller is
   enforced by that gate.

## Receipt Boundary

Future receipts produced after a trust-root-aware receipt contract is adopted
must make the selected trust root explicit so downstream consumers can
distinguish local-operator actions from verified external-client actions.

This ADR does not add a receipt field. Canonical receipt hashes cover the full
payload, including chain linkage. Existing receipt bytes must not be rewritten
or silently backfilled with `local_operator`, because doing so would change
receipt hashes and could invalidate historical chains.

The exact receipt field, vocabulary, schema version, legacy interpretation,
validation rules, canonical serialization, hashing behavior, export behavior,
and reader compatibility require a separate decision gate before any runtime
or schema change.

## External Endpoint Boundary

The future production boundary should be a new explicit SDK or HTTP
external-client entry point. It must be opt-in and default closed. Its contract
must identify:

- the authoritative admission handler;
- the source of client identity;
- exact workspace binding;
- signed-package transport and size limits;
- trusted public-key provisioning and lifecycle;
- replay and freshness rules;
- mutation, audit, receipt, and error ownership;
- whether configuration exposes no route or an unreachable route while the
  feature is disabled.

No existing CLI, local adapter, or generic ingest route is selected as that
endpoint by this ADR.

## Required Sequence

1. `TRUST-ROOT-ADR-0` - this architecture decision.
2. `RECEIPT-TRUST-ROOT-0` - receipt schema, version, hash, chain, and legacy
   compatibility decision.
3. `EXTERNAL-CLIENT-ENDPOINT-0` - default-closed endpoint scope and tests.
4. `EXTERNAL-CLIENT-AUTHORITY-0` - identity, workspace, signed-package, and
   trusted-key binding.
5. `EXTERNAL-CLIENT-ADVERSARIAL-0` - unsigned, wrong-key, expired, replay,
   malformed, and mutation-isolation tests.
6. `EXTERNAL-CLIENT-ENABLEMENT-0` - separate authorization to make the route
   reachable.

Each step requires its own exact-base authorization, independent review,
exact-head merge, and closeout evidence.

## Rejected Alternatives

### Apply the external package gate to every connector

Rejected. Current CLI and local-adapter inputs do not carry the required
external authority evidence. Adding placeholder identity or self-signing would
be security theater and would change existing product behavior.

### Reuse local-operator admission for external clients

Rejected. This would collapse a cryptographic trust boundary into possession
of a transport connection or local-style request fields.

### Backfill historical receipts

Rejected. Historical canonical payloads and their hashes are immutable
evidence. Any legacy interpretation must be specified without rewriting them.

## Stop Conditions

Stop before implementation if any step requires:

- a new public receipt field without an approved schema/version decision;
- rewriting historical receipt payloads or hashes;
- enabling an external route by default;
- weakening existing GitHub or Markdown ingest rejection;
- inventing identity, workspace, package, signature, or trusted-key evidence;
- changing CLI or local-adapter behavior;
- treating a library-only gate as production enforcement;
- adding a dependency when the existing platform is sufficient.

## Non-Claims

This ADR does not claim or implement:

- a production external-client endpoint;
- production connector enforcement;
- a new receipt schema or `trustRoot` field;
- trusted-key provisioning, rotation, revocation, or network resolution;
- replay protection for a production transport;
- GitHub or Markdown external ingest enablement;
- universal connector coverage;
- ecosystem or V5 completion.
