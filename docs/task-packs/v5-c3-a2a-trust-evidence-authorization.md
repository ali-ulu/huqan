# V5-C3 — Bounded A2A Trust Evidence: Authorization

## Status

`AUTHORIZED_FOR_SCHEMA_AND_FIXTURES`

Schema and fixtures only. No runtime wiring, no transport, no route, no
production caller. Entry unblocked by V5-C2 (RFC-001, PR #601), which was the
sole recorded blocker on issue #275.

## Thesis

> HUQAN does not standardize how agents delegate work. It standardizes evidence
> for comparing delegated intent with observed execution.

This is the scope boundary, not a slogan. Every decision below follows from it,
and the forbidden list exists to stop the schema drifting back into a general
agent-to-agent protocol.

The load-bearing chain is five stages, and the schema must keep them separable:

```text
what was authorized/requested
  -> what was actually attempted/executed
    -> what outcome was observed
      -> what evidence proves that observation
        -> did observed execution stay inside the delegation?
```

Existing work in this area — agent identity, delegation scope, signed action
receipts — covers the first stage and the *claimed* form of the third. The
non-overlapping contribution is stages three through five as **observed and
reconciled**, not as reported by the actor being described.

## Source-reality: this is a generalization, not an invention

The thesis is already implemented inside HUQAN at a narrower scope, which is why
C3 is a schema exercise rather than a research one.

### The observed-outcome primitive already exists

`lib/workbench/ingest-approval-action.js` does not trust a plugin's success
return. It compares the admission summary against the observed Graph delta and
carries an outcome vocabulary that encodes observation in the value itself:

```js
const ACTION_OUTCOMES = Object.freeze([
  'admission_allow_graph_write_observed',
  'admission_allow_no_graph_write_observed',
  'admission_review_no_graph_write_observed',
  'admission_reject_no_graph_write_observed',
  'execution_outcome_unknown',
]);
```

with the rule stated in source:

> Observed evidence is authoritative: an `allow` that did not move the Graph is
> reported as no-write-observed, not as a write.

Contradictory, partial or uncertain results become `execution_outcome_unknown`
and are never silently upgraded. C3 lifts exactly this discipline across an
agent boundary.

### The delegation half already has a schema

`schemas/v5/agent-identity.schema.json` already models the authorization side:

```text
agent_id, agent_type, owner_actor_id, workspace_id, requested_workspace_id,
delegation_scope, allowed_tools, allowed_memory_scopes, allowed_connectors,
risk_tier, trust_tier, policy_version, issued_at, expires_at, revoked_at,
revocation_reason, parent_agent_id, delegation_chain, receipt_refs,
provenance_refs, audit_requirements, verification_status
```

C3 **must not re-model any of this.** Identity, scope, chain and expiry are
referenced, not redefined. Re-modelling them would produce a second, drifting
copy of a surface that already exists here and that overlaps heavily with
external agent-identity work — precisely the crowded region this gate should
stay out of.

### The verdict vocabulary already exists

`lib/verdict/action-verdict.js` exports the canonical set:

```text
allow, review, block, dry_run_only, quarantine, disabled
```

C3 reuses it. Inventing a parallel status vocabulary is a stop condition.

## Required schema shape

One schema with four clearly separated sections. The separation is the
deliverable; collapsing any two of them defeats the gate.

### 1. Delegation / request — what was authorized

Source and target agent identity, workspace, delegation scope, requested action,
`requestedOutput` (the expected or requested result), constraints, expiry,
delegation chain. Identity and scope fields **reference**
`agent-identity.schema.json`; they are not restated.

### 2. Observation — what actually happened

`observedAction`, `observedOutcome`, an effect summary, and `observedAt`.

`requestedOutput` and `observedOutcome` are **separate required fields and must
never be merged**. A single `output` field is the failure mode this gate exists
to prevent: an implementer six months from now says "output already covers it"
and post-execution evidence quietly collapses back into self-report.

`observedOutcome` must be able to express uncertainty. An unknown or
contradictory observation is a valid, recordable state — following
`execution_outcome_unknown` — and must never be representable only as success or
failure.

### 3. Evidence binding — what proves the observation

Evidence references and hashes, plus a trust receipt reference and hash. The
observation is only worth as much as what backs it, so an observation without
evidence binding must be structurally distinguishable from one with it.

### 4. Reconciliation — did execution stay inside the delegation

Scope match, requested-versus-observed match, approval/risk result, delegation
chain validity. This section is the verdict of the envelope and the reason it
exists.

## Falsification condition

Delete `observedOutcome` and the evidence-binding fields. If what remains is
still a meaningfully distinct HUQAN artifact, the schema is too general and in
the wrong scope: it has become another delegation-request format.

The correct outcome in that case is
`V5_C3_A2A_TRUST_EVIDENCE_BLOCKED_GAP`, not a wider schema.

This is checked deliberately, not assumed. The fixtures must include the
falsification form so the check is mechanical.

## Forbidden

Each entry is a way this gate turns into a general A2A protocol:

- **no discovery** — how agents find each other;
- **no message routing or addressing**;
- **no capability advertisement or negotiation**;
- **no generic task lifecycle** — states like queued/running/cancelled;
- **no transport** — HTTP, WebSocket, queue semantics, retries, delivery
  guarantees;
- no re-modelling of agent identity, delegation scope, chain or expiry;
- no new verdict vocabulary parallel to `action-verdict.js`;
- no runtime wiring, route, CLI, MCP or production caller;
- no dependency;
- no change to `lib/`, `graph.js`, `kernel.js`, `server.js`, `storage.js` or
  `plugins/`;
- no claim that A2A trust exchange is implemented, reachable or proved.

If a bounded exchange later needs transport, that is a separate gate with its
own authorization.

## Required fixtures

Valid, invalid and expired forms are required by issue #275. Concretely:

1. **valid** — delegation, observation, evidence and reconciliation all present
   and consistent;
2. **scope exceeded** — observed action outside `delegation_scope`;
3. **requested-vs-observed mismatch** — execution succeeded but produced
   something other than `requestedOutput`;
4. **unknown outcome** — contradictory or missing observation, recorded as
   unknown rather than resolved;
5. **missing evidence** — observation asserted with no evidence binding;
6. **expired** — observation after `expires_at`;
7. **broken delegation chain**;
8. **falsification form** — `observedOutcome` and evidence removed, retained to
   prove the remainder is not a viable artifact.

Every negative fixture must fail closed. A fixture that merely warns is a stop
condition.

## Acceptance evidence

1. the four sections are separately identifiable in the schema, and
   `requestedOutput` and `observedOutcome` are distinct required fields;
2. identity, scope, chain and expiry reference `agent-identity.schema.json`
   rather than restating it;
3. the canonical verdict set is reused, not re-declared;
4. `observedOutcome` can represent unknown;
5. all eight fixtures exist, and each negative fails closed with a specific
   reason;
6. the falsification check is executed and recorded, not asserted;
7. no forbidden surface appears anywhere in the diff;
8. targeted tests and full `npm test` pass on the exact head.

The implementation candidate must finish with exactly one verdict:

```text
V5_C3_A2A_TRUST_EVIDENCE_SUFFICIENT
V5_C3_A2A_TRUST_EVIDENCE_BLOCKED_GAP
```

## Non-claims

Closing C3 proves a schema and its fixtures. It does not prove that any two
systems exchanged anything, that a HUQAN observation of a remote agent is
obtainable in practice, or that the evidence model survives contact with a real
counterparty.

The hard open question is deliberately left open: **who observes?** A schema can
require an observation and its evidence, but it cannot supply a party positioned
to make one that neither agent controls. Where that ground truth comes from is
not a schema problem, and pretending otherwise here would make the envelope look
stronger than it is.

`V5_IMPLEMENTATION_ENTRY: FAIL` is unchanged. C5 (#277) remains blocked on
C4 (#276) and on external interoperability evidence.
