# V5 P1-A — Identity Enforcement Threat Model

**Status:** `spec`

**Source snapshot:** reconciled against live source at
`main @ 1c6f3f8abd717af35848a9ba7229f8c6cd8ddad0`.

## What this document is

A security boundary specification. It answers three questions and stops:

- which threats are in scope,
- which control catches each one,
- what evidence each control must produce.

It is **not** an implementation plan. It selects no runtime hook, authorizes no
code, and does not schedule work. Gate 1 of the eight named in
`docs/v5/v5-agent-identity-closeout-audit.md`.

## The question being answered

HUQAN is not a generic identity provider. Per
`docs/v5/v5-agent-identity-contract.md`, it evaluates identity claims as
deterministic trust inputs. The question is therefore not:

> "Who is this agent?"

but:

> "Is this agent's identity claim acceptable **for this action**, inside **this
> workspace**, under **this delegation chain**, in **this connector context**?"

That distinction narrows P1 considerably. Establishing identity is somebody
else's job; deciding whether an established claim may be relied on here is this
one.

## The acceptance predicate

```text
accept(claim, action, ctx) =
      valid(claim)                             // signature, shape, provenance
    ∧ boundTo(claim, ctx.workspaceId)          // ADR-011 boundary
    ∧ notExpired(claim, ctx.evaluationTime)    // receiver-owned clock
    ∧ withinDelegationScope(action, claim)     // authority limit
    ∧ connectorContextIntact(claim, ctx)       // whose behalf, through what
```

`evaluationTime` is named as an input rather than read as a property of the
claim. Expiry is a fact about the *evaluation*, not about the document, and a
receipt that cannot say which clock it was judged against cannot be reproduced.
`lib/a2a/bounded-exchange.js` already takes the clock from the receiver
authority and never from the payload; this predicate keeps that explicit.

The value of the conjunctive form: **each attacker class in scope defeats
exactly one conjunct.** The control separation below is therefore derived from
the threats rather than chosen for tidiness.

## Threats in scope

Four classes, kept separate. Collapsing them into one "identity spoofing" threat
would be the central error this document exists to prevent: credential
compromise and delegation escalation are both "a real identity doing something
wrong", and they require different controls.

| Attacker class | Conjunct attacked | Control family | Relation to `workspaceId` |
|---|---|---|---|
| Malicious external agent (A2A counterparty) | `valid` | Claim validation + provenance + trust evaluation | In which workspace context is the claim evaluated? |
| Authorised internal agent exceeding scope | `withinDelegationScope` | Delegation policy + action boundary | Authority limit *inside* a workspace |
| Compromised connector / credential | `notExpired`, `connectorContextIntact` | Connector boundary + revocation + expiry | On whose behalf is the credential acting? |
| User reaching another workspace | `boundTo` | Workspace binding + isolation | The primary boundary (ADR-011) |

## Why the controls are not substitutable

Identity validation alone is insufficient. Each row below is a scenario that
passes every other control:

| Scenario | Only this catches it |
|---|---|
| Valid claim, wrong workspace | `boundTo` |
| Valid claim, action beyond granted scope | delegation scope |
| Valid claim, expired | `notExpired` against the receiver clock |
| Genuine credential, broken connector context | connector boundary |

A signature can be mathematically valid while every one of these is true. Any
simplification that treats one control as a special case of another silently
reopens that row.

## Evaluation order

The controls are ordered, and the order is a fail-closed property rather than a
performance choice:

```text
valid → boundTo → notExpired → withinDelegationScope → connectorContextIntact
```

Reading a claim's workspace before the claim is verified means trusting a field
under the attacker's control. `lib/a2a/bounded-exchange.js` already evaluates in
this order — shape and signature, then binding, then scope. P1 inherits that
order rather than re-deriving it.

## Evidence each control must produce

A control must emit not just a decision but evidence that can be linked to a
Trust Receipt (gate 6). A receipt carrying only "denied" cannot answer the
question that makes a deterministic trust boundary meaningful:

> **Which trust assumption failed?**

### Reason namespaces

Each control family owns a stable reason **namespace**. The namespace is the
commitment; sub-reasons grow under it, deliberately and slowly.

```text
identity.invalid_claim
identity.workspace_binding_failed
delegation.scope_exceeded
delegation.chain_invalid
connector.context_invalid
connector.revoked
```

Two rules govern growth:

1. **A control family must never fall through to a generic denial.** If it does,
   the receipt cannot evidence which security property was engaged.
2. **Not every error message becomes a reason code.** The vocabulary grows under
   review, not per failure site. An unbounded vocabulary is as unusable as a
   single `denied`.

`lib/a2a/bounded-exchange.js` is the working precedent: its reason for a refusal
reads identically in the conformance report and in the HTTP response.

## What the A2A evidence does and does not prove

All four control families have a working, conformance-tested implementation at
the A2A exchange surface — 50 negative cases, including `workspace_confusion`,
`delegation_scope_escalation`, `delegation_chain_invalid`, `delegation_expired`,
`identity_binding_invalid`, `revoked_source_key` and
`evidence_package_authority_invalid`.

That is genuine evidence, and it is bounded:

- it covers **exchange acceptance**, not mutation;
- it covers the canonical workspace `default` only, so `boundTo` has not been
  exercised against a real multi-workspace distinction;
- it covers a single caller.

**P1 therefore investigates carrying the control families validated in A2A to new
enforcement surfaces. A2A evidence alone is not runtime enforcement evidence.**

This is the same distinction the identity closeout audit draws between a
conformance validator working and runtime enforcement existing, and it is
restated here because the temptation to skip it is stronger when the prior work
is real code rather than a fixture validator.

## Known gaps

```text
Known gap:
The current evaluator is proven at A2A exchange acceptance.
It is not yet proven as a mutation enforcement boundary.
Hook selection is deferred to Gate 2.
```

```text
Known gap:
Connector boundary exists as a package allowlist only.
Credential lifecycle enforcement -- revocation, expiry, rotation, and
behaviour on a compromised credential -- does not exist.
Scope is deferred to Gate 3.
```

The connector boundary contains two separable problems, and this document
records the split without resolving it:

1. **Structural boundary** — which connector may be used, which capability is open.
2. **Credential lifecycle** — revoke, expiry, rotation, compromised-credential behaviour.

The second needs its own policy and evidence model. This threat model names it as
a threat; Gate 3 decides the implementation scope.

## Hook selection is deferred (Gate 2)

Gate 2 covers runtime hook location. This document deliberately does not choose
between MCP, CLI, HTTP workflow routes or the GitHub App. Choosing a surface
before a caller's requirement selects it would repeat precisely the error P0
avoided when it deferred its framing decision.

What this document fixes instead is the criteria, so that Gate 2 becomes an
evidence comparison rather than an architectural preference:

1. **Runs before the mutation.** A2A's reserve-before-effect ordering is the
   working example.
2. **Is the single entry point, and cannot be bypassed.** *Measurable:* a
   reachability proof that every mutation path on that surface passes through the
   point. `lib/module-reachability.js` can measure this.
3. **Can fail closed.** An unresolvable identity rejects; it never defaults.
4. **Produces Trust-Receipt-linkable evidence**, under the namespace rules above.
5. **Integrates without breaking the existing caller contract.** *Measurable:*
   that surface's existing tests pass unchanged.

Criteria 2 and 5 carry measurable tests because "cannot be bypassed" and "does
not break anything" are otherwise matters of opinion.

```text
Runtime hook location: TBD -- evidence-backed selection required (Gate 2).
```

## Relationship to other decisions

- **ADR-011** fixes `workspaceId` as the tenancy enforcement boundary, so
  `boundTo` has a named primitive rather than an open question.
- **`docs/v5/v5-agent-identity-closeout-audit.md`** gates runtime enforcement
  behind eight items; this document is gate 1 and does not satisfy any other.
- **`docs/v5/v5-agent-identity-contract.md`** is `future` — planning only. This
  document takes its *framing* (claims as trust inputs) and does not treat it as
  a binding contract.

## Non-claims

This document does not claim that runtime identity enforcement, connector
identity enforcement, credential lifecycle enforcement, multi-workspace
authority or a mutation enforcement boundary exists; that a runtime hook has
been chosen; that the A2A evidence constitutes runtime enforcement evidence;
that gates 2 through 8 are satisfied; or that any third party has verified
anything.
