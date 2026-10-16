# P3 Child 1 — Agent registry record shape

**Status:** `spec`

**Parent issue:** #848

**Child issue:** #876

**Mode:** Docs-first task pack only. No implementation; the wiring PR is a separate, single-purpose unit.

**Canonical base:** `main @ 50faaec879bc3fbb0df70a133bf6e140dac50362`

## 1. The dependency is satisfied, and what it contributes

P0-C (PR #850) and P0-D (PR #852) are merged at the base. Their surfaces are the registry record's only legitimate foreign references:

| Reference | Source at the base | What the record borrows |
|---|---|---|
| Canonical Agent Card | `lib/a2a/agent-card.js::buildAgentCard` | `agentId`, `identityRef`, `identityHash`, `workspaceId`, `receiverAuthorityId` — the exact `authority.expectedTarget` shape, copied from the card's own fields, never invented |
| Negotiated capability set | `lib/a2a/capability-negotiation.js::negotiateCapabilities` | the `agreement.capabilities` id list and `agreement.protocolVersion`, as a **subset of the offer** (receiver-owned by construction) |
| Trust root resolution | `lib/v5/trusted-key-resolver.js::resolveTrustedKeyState` | key state vocabulary: `active` admitted, `revoked / expired / unknown / unavailable / malformed` rejected — no second key authority |
| Admission auth | `lib/http/route-auth-policy.js::AUTHENTICATED_ROUTES` | the registry surface is a new authenticated route id, not a public one |

## 2. The record shape — and nothing else

A registry record stores exactly five groups of fields. Any field outside these groups is out of this unit's scope by design: discovery material belongs to a later unit, revocation mechanics to revocation, telemetry to observability.

| Group | Fields | Owner | Source of truth |
|---|---|---|---|
| identity | `agentId`, `identityRef`, `workspaceId` | receiver | Agent Card `expectedTarget` |
| capability | `protocolVersion`, `capabilityIds: [id]` | receiver (subset of the offer) | negotiation `agreement` |
| version | `recordVersion` (monotonic integer, starting at 1) | receiver | registry's own counter |
| auth requirement | `authenticationRequired: true` (constant; public registry records do not exist in this unit) | receiver | P3 invariant |
| trust root | `trustRootReference` (a `keyReference` resolving through `resolveTrustedKeyState`) + `resolvedKeyState`, `resolvedReasonCategory` | receiver | trusted-key-resolver |

Explicitly **absent**: `identityHash` (a disclosure surface decision this unit does not make), `expiresAt` on the record itself (revocation is fail-closed; expiry belongs to the trust root's key record, not the registry record — the shape must not preclude revocation later, which it does not, since the trust root re-resolves per access), display metadata, endpoints, health data, and any event or trace material.

### The receiver-ownership rule, applied mechanically

No field in the record may originate from the registering agent's own request body where a receiver-owned counterpart exists. The only request-body material admitted is the identity and capability request, and even that is admitted **only after** the registry verifies it against what the receiver already holds:

1. `agentId`/`identityRef`/`workspaceId` must match a card the receiver itself served or bound in an exchange — a request with a plausible identity that the receiver has no record of fails closed.
2. `capabilityIds` must be a non-empty subset of the receiver's own `CAPABILITIES` ids and the `protocolVersion` one of `SUPPORTED_PROTOCOL_VERSIONS`.
3. `trustRootReference` must resolve through `resolveTrustedKeyState` to `active` at evaluation time, with receiver clock — a `revoked`, `expired`, `unknown`, `unavailable` or `malformed` state rejects the whole admission, never partially.

## 3. The admission and query surface contract

```text
POST /api/registry/records        (new route id in AUTHENTICATED_ROUTES; auth via route-auth-policy)
  → request shape validation (bounded strings, bounded list)
  → identity match against receiver-held card/exchange record
  → capability subset check against receiver CAPABILITIES table
  → resolveTrustedKeyState on the submitted trustRootReference
  → reject (fail-closed) or accept with {recordId, recordVersion}
  → persist as the bounded record above, nothing else

GET /api/registry/records/:recordId   (authenticated; same route family)
  → returns only the five stored groups
  → re-resolves the trust root at read time: revoked/expired → excluded from response with a bounded reason, never a stale "admitted" copy
```

**Exact file list the wiring PR may touch:**

- one route module under `lib/registry/` (the admission + query handlers; no discovery, health, or telemetry code)
- `lib/registry/registry-record-shape.js` (record validation, frozen, require-free in spirit of the V5 library style)
- `lib/http/route-auth-policy.js` (two new authenticated route ids)
- `lib/http/routes.js` or the registry equivalent composition (one dispatch line, not in `server.js`)
- persistence reusing the existing V4 journal/receipt family — **no second store**
- one or two test files, plus doc updates

**Forbidden in the wiring PR:** any `.well-known` or public discovery surface; any revocation mechanism beyond the trust-root rejection rule; any health/readiness endpoint (the generic `GET /health` is unrelated); tracing, metrics or logging additions; any `lib/v5` or `lib/a2a` modification; any change to the Agent Card or negotiation outputs; widening the reachability ledger.

## 4. Stop conditions

1. **Identity match cannot be bounded** at wiring time (no receiver-held card/exchange record exists to match against): the PR must report blocked rather than admit self-asserted identities — self-assertion is the exact failure this unit was created to prevent.
2. **A genuine need for public card retrieval emerges:** that is a separate, explicitly authorized P3 unit; this pack does not pre-authorize it.
3. **Persistent store shape exceeds the V4 journal family:** outbox/store decisions belong to the dead-letter/replay unit, not here.

## 5. Acceptance preview (binding only in the wiring PR)

Tests must prove: a valid registration admits and returns the bounded record; a self-asserted identity without a receiver-held match fails closed; an unknown/revoked/expired trust root fails closed and leaves no partial record; a revoked trust root at read time excludes an otherwise-admitted record; duplicate identity registration bumps `recordVersion` without creating a second record; and all reachability, doc-status, file-size and conformance gates stay green. Actual criteria live in the wiring PR's own task pack.

## Non-claims

This unit does not claim a registry, a discovery surface, revocation tooling, a health endpoint or replay exists today. It claims only a bounded record shape, its receiver-owned admission contract, and the exact file list a single-purpose wiring PR may touch.
