# V5 P1 Gate 4 — Workspace Binding and Delegation Policy

**Status:** `spec`

**Parent issue:** `#846` (P1, agent identity enforcement chain). Gate 4
of the eight gates named in
`docs/v5/v5-agent-identity-closeout-audit.md`.

**Child issue:** none assigned yet; this document is the task pack. The
implementation unit is a separate, single-purpose PR and is **not**
authorized here.

**Mode:** Docs-first task pack only. No implementation, no new tests, no
wiring. This document changes exactly one file.

**Canonical base:** `main @ 23541ba` (merge of PR `#897`). A successor
must re-verify its own exact SHA.

## 1. Source reality

### 1.1 What Gate 4 must specify

The closeout audit names Gate 4 as **workspace binding and delegation
policy**. The threat model (`docs/v5/v5-p1a-identity-threat-model.md`)
fixes the two conjuncts this gate writes:

```text
accept(claim, action, ctx) =
      valid(claim)
    ∧ boundTo(claim, ctx.workspaceId)          // ADR-011 boundary
    ∧ notExpired(claim, ctx.evaluationTime)
    ∧ withinDelegationScope(action, claim)     // authority limit
    ∧ connectorContextIntact(claim, ctx)
```

Two threat-table rows are Gate 4's exclusive responsibility, and the
threat model states that each passes **every other control** if Gate 4
is weak:

| Scenario | Only this catches it |
|---|---|
| Valid claim, wrong workspace | `boundTo` |
| Valid claim, action beyond granted scope | delegation scope |

### 1.2 ADR-011 gives this gate a named primitive

`docs/adr/ADR-011-tenancy-enforcement-boundary.md` (Accepted) fixed
`workspaceId` as the tenancy enforcement boundary and ruled out
`tenantId`:

- `TENANCY_PRIMITIVE: workspaceId`, `TENANT_ID: not_established`.
- Tenant-level semantics do not exist in the current product model,
  and the ADR refuses to introduce two isolation identifiers "neither
  clearly authoritative, with enforcement free to consult whichever is
  convenient at each call site".
- The ADR's own consequence statement names Gate 4: *"P1's remaining
  gates get a concrete boundary. Workspace binding and delegation
  policy (gate 4) can now be specified against a named primitive
  instead of an open question."*
- Enforcement is mechanical: `test/tenancy-boundary.test.js` fails if
  `tenantId`/`tenant_id` enter runtime source, or if the
  `workspaceId` boundary helper stops being production-reachable.
  Reversal is a visible diff.
- ADR-011 explicitly does **not** claim the workspace boundary is
  enforced for identity claims today — "that is what P1 must build".

This means Gate 4 **cannot** widen tenancy: threading `tenantId`
through the claim surfaces is a boundary violation the guard test
would catch, and the consequence row leaves the binding job to P1.

### 1.3 What the A2A surface already proves, and what it cannot

`lib/a2a/bounded-exchange.js` is the working precedent this gate
inherits:

- Delegation hops carry their own `workspaceId`, and every participant's
  identity record is checked `entry.record.workspace_id ===
  request.workspaceId` — the binding check already exists at exchange
  acceptance.
- `validateIdentityRecord` enforces `delegation_scope` (non-empty
  required, unique strings), `delegation_chain` (unique strings,
  `parent_agent_id ∈ {null} ∪ chain`), `allowed_tools` /
  `allowed_memory_scopes` / `allowed_connectors` (subsets of the
  parent), `revoked_at === null`, and expiry strictly after
  `evaluationTime`.
- `subset()` implements the authority-limit rule: a delegate's scope
  must be a subset of the delegator's; nothing may be granted that was
  not held.
- The reason namespaces are already fixed:
  `identity.workspace_binding_failed`,
  `delegation.scope_exceeded`, `delegation.chain_invalid`.

The threat model states the evidence boundary in one sentence this
pack must keep: *"it covers the canonical workspace `default` only, so
`boundTo` has not been exercised against a real multi-workspace
distinction; it covers a single caller."* Conformance evidence is not
runtime enforcement evidence, and Gate 4 must not pretend otherwise.

### 1.4 The known gap this gate writes into, not closes

Multi-workspace authority is unimplemented everywhere: P0 serves the
canonical `default` workspace only, and the A2A evidence exercises
exactly one caller against one workspace. Gate 4's job is therefore to
write the policy **as-if multi-workspace** (so enforcement can carry
it) while recording that the distinguishing evidence does not yet
exist — the same docs-first discipline Gate 3 applied to its lifecycle
events.

## 2. The decision

Gate 4 writes the **binding and delegation policy** — what must be
enforced — without choosing where (Gate 2 keeps hook selection) and
without implementing enforcement. The policy has four parts:

### 2.1 Workspace binding rule (`boundTo`)

- A claim's binding is **evaluated, not read**: the evaluation input is
  the receiver-owned `workspaceId` for the action being authorized; a
  workspace identifier supplied inside the payload is evidence material
  to be checked, never authority to be trusted. Any evaluation that
  takes the workspace from the claim instead of the evaluation context
  reopens the "user reaching another workspace" row.
- Binding failure is `identity.workspace_binding_failed` — the only
  reason in its namespace — and it must never fall through to a
  generic denial (the threat model's no-fallthrough rule).
- The binding check is a **pure equality judgment against the named
  primitive**: `workspaceId`, per ADR-011. No derived, heuristic, or
  fuzzy match may substitute; the guard test forbids the alternative
  identifier entirely.

### 2.2 Delegation rule (`withinDelegationScope`)

The delegation rule inherits bounded-exchange's four mechanisms and
fixes their policy semantics:

- **Scope is bounded by possession** — a delegate may act only within
  `delegation_scope` entries the delegator held; `subset()` is the
  canonical implementation of "nothing may be granted that was not
  held".
- **Scope failure is `delegation.scope_exceeded`**; it is a distinct
  control from chain failure — a valid chain that authorizes too much
  and a broken chain that authorizes nothing are different threats,
  and collapsing them would be the threat table's own error.
- **Chain validity is `delegation.chain_invalid`**: every hop's
  `parent_agent_id` must anchor to the previous hop or null, the chain
  is unique (no duplicated or circular hops), and a claim whose chain
  cannot be resolved rejects rather than degrades to chain-less
  evaluation.
- **Per-hop integrity**: each hop carries its own `workspaceId` and
  scope, and is validated against the same receiver clock
  (`evaluationTime`) as the claim itself — an expired intermediate hop
  invalidates the delegation even when the leaf is nominally fresh.
- **`maxRiskTier` is the delegation floor, not ceiling**: the
  delegation may lower the risk a delegate may present but cannot
  raise the delegator's; any request asserting a tier above the
  delegation's bound is `delegation.scope_exceeded`.

### 2.3 Clock rule

Gate 3 already fixed that expiry is a fact about the evaluation and
not the document. Gate 4 extends the same discipline to delegation:
the evaluation input `evaluationTime` is a single receiver-owned clock
applied to the claim, every hop, and every scope entry — one clock,
checked once per object, named in the evidence.

### 2.4 Evidence rule

Every binding and delegation decision emits evidence under the fixed
namespaces — `identity.workspace_binding_failed`,
`delegation.scope_exceeded`, `delegation.chain_invalid` — and the
refusal reads identically in the conformance output and the API
response (the bounded-exchange precedent). The delegation decision
must also record which workspace the delegation was judged inside,
because a replayed delegation evaluated in a different workspace is a
different decision.

**Three deliberate non-decisions** this gate keeps:

- **Hook location** stays Gate 2's — the policy is written so
  `module-reachability.js` can verify any candidate hook against the
  four criteria without re-reading this pack.
- **Multi-workspace operation is not claimed.** The policy is written
  to be exercised by more than one workspace, but until a second
  workspace distinction exists in source and evidence, asserting
  multi-workspace enforcement would be the exact category of
  unproven claim the threat model's known-gap section exists to
  forbid.
- **No tenancy extension.** `tenantId` remains unestablished per
  ADR-011; this gate does not create it, reference it, or imply it.

## 3. What the implementation unit may do

**Allowed**, in exactly this order — a single bounded PR whose subject
is the policy's *shape* as executable contract, not enforcement on any
path:

1. A bounded policy module (or equivalent home): `boundTo` and
   `withinDelegationScope` as pure, deterministic functions — binding
   equality, scope subset, chain resolution, per-hop clock checks —
   with no side effects, consistent with the writer kernel discipline
   of PR `#894`/`#895` and the Gate 3 policy module's rules.
2. One conformance test set asserting: wrong-workspace claim →
   `identity.workspace_binding_failed`; scope-exceeding action →
   `delegation.scope_exceeded`; broken chain (circular, duplicated,
   unanchored, or missing parent) → `delegation.chain_invalid`;
   expired hop → refusal even with a fresh leaf; payload-supplied
   workspace never treated as evaluation context.
3. A `test/tenancy-boundary.test.js` compatibility assertion that the
   policy module neither introduces nor consults a second isolation
   identifier — the guard test's discipline carries into the new
   module rather than being relaxed around it.

**Forbidden:**

- any change to `lib/v5/trusted-key-resolver.js`, the package schema,
  the receipt plane, the writer/reader kernels, `audit-log`, `ingest`,
  `storage.js` lookups, the A2A exchange, `replay-store.js` beyond the
  read-keys contract, tracing, metrics, or logging semantics;
- introduction of `tenantId`/`tenant_id` into runtime source, in any
  file the guard test measures — this is a hard, test-enforced line;
- enforcement on any production path; paths stay at their current
  coverage-matrix status until their own wiring PRs;
- a hook choice, a registry table, an outbox, or a second key
  authority;
- multi-workspace enforcement claims without a second real workspace
  in source and evidence;
- payload-supplied workspace identifiers treated as evaluation
  context.

## 4. Acceptance preview (binding only in the implementation unit)

1. The policy module is pure: same inputs, same outputs, no side
   effects, no environment reads.
2. All five refusal paths have failing-on-violation conformance tests;
   refusal reasons read identically in conformance output and API
   response.
3. The guard test (`test/tenancy-boundary.test.js`) stays green — the
   policy module contains no `tenantId`/`tenant_id` references and
   keeps the `workspaceId` boundary helper production-reachable.
4. `lib/module-reachability.js` can verify a candidate hook's four
   criteria against this policy without code changes elsewhere.
5. File-size, cycle, status-declaration, and acyclicity checks stay
   green; touched files stay within their ratchet limits; tarball smoke
   tests (`4C1`), module reachability, and the 4437-test suite stay
   green; no ledger graduation happens.

## 5. Invariants

1. One tenancy primitive (`workspaceId`), one delegation vocabulary,
   one evaluation clock — a decision that consults two identifiers or
   two clocks is an ambiguous decision, and ambiguity is the failure
   mode ADR-011 exists to prevent.
2. Fail-closed in both directions: an unresolvable binding rejects,
   and an unresolvable delegation chain rejects whole; neither failure
   opens anything.
3. The policy defines *what*, never *where*: hook selection remains
   Gate 2's evidence comparison.
4. Conformance evidence is recorded with its known limits (canonical
   `default`, single caller); the evidence plane says what it tested,
   not what it did not.
5. Observability adds no new authority; evidence records decisions, it
   never changes them.

## 6. Non-claims

This record does not claim that workspace binding or delegation policy
is enforced on any path today; that multi-workspace authority exists
anywhere in the product; that the A2A exchange's `workspaceId` checks
prove runtime enforcement beyond exchange acceptance; that this pack
authorizes enforcement; or that ADR-011 has been reversed or weakened
— the guard test's mechanics are unchanged by this document, and any
implementation unit that would change them must do so as a separate,
explicit ADR process.

## 7. Gate order

- [x] Gate 1 — identity enforcement threat model (`v5-p1a-identity-threat-model.md`)
- [ ] Gate 2 — runtime hook location and fail-closed behavior
- [x] Gate 3 — connector boundary policy (`v5-p1-gate3-connector-boundary-policy.md`)
- [x] Gate 4 — workspace binding and delegation policy (this task pack, docs-only)
- [ ] Gate 5 — revocation / expiry behavior
- [ ] Gate 6 — Trust Receipt linkage requirements
- [ ] Gate 7 — conformance fixtures for enforcement behavior
- [ ] Gate 8 — rollback and migration plan
