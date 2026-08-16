# ADR-011 - Tenancy Enforcement Boundary

## Status

Accepted boundary decision.

```text
TENANCY_PRIMITIVE: workspaceId
TENANT_ID: not_established
```

This ADR decides which identifier is the tenancy enforcement boundary. It does
**not** authorize runtime identity enforcement, which remains gated by
`docs/v5/v5-agent-identity-closeout-audit.md`.

## Source Snapshot

Reconciled against live repository state at:

```text
repository: ali-ulu/huqan
package: 0.9.1
main: 501fd3729cffd93069a3894a856ae5504a582dc6
```

Verified at that commit:

- `workspaceId` appears across ~145 source files and is enforced at the HTTP
  boundary by `lib/http/exact-workspace.js`.
- `tenantId` and `tenant_id` appear **nowhere** in the repository.

## Decision

**`workspaceId` is the tenancy enforcement boundary**, and it is first-class:
authority, delegation and judgment are bound to it.

**`tenantId` is not established.** It is not an enforcement primitive, not a
synonym for `workspaceId`, and not a field to be threaded through in
anticipation.

The model this fixes:

```text
identity claim
      ↓
workspaceId
      ↓
delegation / authority
      ↓
action
      ↓
HUQAN judgment
```

## Why `workspaceId`

One of the threats P1 accepts is *a user reaching into another workspace*. The
natural enforcement boundary for that threat is the workspace itself, and the
repository already expresses it that way — `lib/http/exact-workspace.js` is
production, and P0 pinned the A2A surface to the canonical workspace `default`.

Choosing `workspaceId` therefore ratifies a boundary the system already has,
rather than introducing one.

## Why not `tenantId`

A second identifier is only justified by a second isolation *semantics*. It
would have to mean something like:

```text
tenant
 ├── workspace A
 ├── workspace B
 └── workspace C
```

with real shared authority, policy, billing or identity isolation at the tenant
level, distinct from the per-workspace boundary.

No such semantics exists in the current product model, and nothing in live
source evidences one. Adding `tenantId` now would put two isolation concepts
into the system before either is proven to need the other — and the failure mode
is not a missing feature but an ambiguous one: two identifiers, neither clearly
authoritative, with enforcement free to consult whichever is convenient.

Leaving both implied was the one option ruled out. This ADR rules it out by
naming one and rejecting the other, rather than by staying silent.

## What would reverse this

Evidence of tenant-level semantics that the workspace boundary cannot express:
authority, policy, revocation or isolation that must hold across a *set* of
workspaces and cannot be stated per workspace.

Until such evidence exists, introducing `tenantId` is premature abstraction.

## Enforcement

A decision recorded only in prose decays. `test/tenancy-boundary.test.js` fails
if `tenantId` or `tenant_id` is introduced into runtime source, and fails if the
`workspaceId` boundary helper stops being production-reachable.

Reversing this ADR therefore requires editing that test, which makes the reversal
a visible diff rather than a quiet drift — the same discipline
`lib/module-reachability.js` and the Agent Card's `unsupported` list use.

## Consequences

- **P1's remaining gates get a concrete boundary.** Workspace binding and
  delegation policy (gate 4) can now be specified against a named primitive
  instead of an open question.
- **Identity claims bind to a workspace,** not to a tenant. How that binding is
  established and enforced is P1-A's subject, not this ADR's.
- **The A2A surface is unaffected.** P0 serves canonical workspace `default`
  only; this ADR does not widen that, and multi-workspace authority remains
  unimplemented.

## Non-claims

This ADR does not claim that runtime identity enforcement, connector identity
enforcement, multi-workspace authority or multi-tenant authority exists; that
the workspace boundary is currently enforced for identity claims (it is not —
that is what P1 must build); or that any third party has verified anything.
