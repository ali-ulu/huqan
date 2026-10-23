# Approval RBAC

Role-based approval authority (#4205). This page describes the slice that
ships today: roles and permissions, the signed operator identity a decision
carries, separation of duties, and the audit record of every governed
decision. Quorum and execution-receipt identity propagation are named under
[Not in this slice](#not-in-this-slice).

## Opt-in

RBAC is off until a policy file is named:

| Variable | Meaning |
| --- | --- |
| `HUQAN_RBAC_POLICY_PATH` | Path to the policy JSON. Unset: no RBAC, single-user behaviour is byte-identical to today. |
| `HUQAN_AUTHORITY_OPERATOR_ID` | Identity the approval authority writes into every decision it signs. Must match an `operators` key in the policy. |

`AXIOM_RBAC_POLICY_PATH` is accepted as the legacy alias of the first.

The policy is local configuration, not a signed document. It maps the identity
asserted by the authority to a role. Protecting the file is the deployment's
job; SSO (#4204) will change where the authority learns that identity, not this
mapping.

## Policy file

`config/rbac.example.json` is a complete, valid example. The schema is strict:
unknown fields, unknown permissions, an operator naming a role that does not
exist, or a non-boolean `separationOfDuties` make the policy invalid, and an
invalid policy refuses every decision.

```json
{
  "version": 1,
  "roles": {
    "approver": ["approvals.view", "approvals.decide"]
  },
  "operators": {
    "operator-1": "approver"
  },
  "separationOfDuties": false
}
```

Permissions are a closed list: `approvals.view`, `approvals.decide`,
`approvals.manage`. Only `approvals.decide` is enforced on this path today;
the other two describe the queue and policy-management surfaces that follow.

## Role matrix

Both roles and their permissions live in the policy file. The matrix below is
the shipped example, and `test/approval-rbac.test.js` fails if this table and
`config/rbac.example.json` diverge.

| Role | Permissions | May do |
| --- | --- | --- |
| `viewer` | none | Read the queue |
| `operator` | `approvals.view` | Read the queue |
| `approver` | `approvals.view`, `approvals.decide` | Approve or reject |
| `admin` | `approvals.view`, `approvals.decide`, `approvals.manage` | Approve, reject, manage the policy |

## Approval queue CLI

`huqan approvals list` lists the same bounded, read-only approval queue as
`huqan approvals`; the existing spelling remains supported. Add
`--workspace <id>` to scope the queue to a workspace.

The command is operator-gated, but the policy permission `approvals.view` is
not yet enforced on the queue read path. The role matrix above describes the
configured policy; only `approvals.decide` is enforced in this slice.

## How a decision is authorized

1. The authority signs a decision envelope for one approval, workspace, tool
   and action hash. With `HUQAN_AUTHORITY_OPERATOR_ID` set, the envelope also
   carries `operatorId`, inside the signature.
2. The runtime verifies the envelope against the pinned key (ADR-016). An
   unsigned or foreign decision never reaches RBAC.
3. RBAC reads `operatorId` from the verified payload and looks up its role.
   The decision is allowed only when the role grants `approvals.decide`.

Refusals are total, with distinct codes:

| Code | Cause |
| --- | --- |
| `APPROVAL_RBAC_POLICY_INVALID` | The policy is missing, unreadable, or malformed. |
| `APPROVAL_RBAC_OPERATOR_REQUIRED` | A policy is configured but the decision has no signed `operatorId`. |
| `APPROVAL_RBAC_OPERATOR_UNKNOWN` | The signed identity has no role. |
| `APPROVAL_RBAC_PERMISSION_DENIED` | The role exists but lacks `approvals.decide`. |
| `APPROVAL_RBAC_SEPARATION_OF_DUTIES` | The requester and the approver are the same identity, and separation of duties is on. |

A refusal leaves the approval pending. It does not reject it and cannot be
retried into an approval without a new decision.

Because the identity is only asserted once a policy exists, configuring a
policy while the runtime runs in legacy mode (no authority installed) refuses
every decision: there is no signed identity to place.

## Separation of duties

Off by default, per the issue. When `separationOfDuties` is `true`, an operator
cannot decide an approval whose recorded requester is the same identity.

The requester id comes from the approval row (`context.provenance.actor`),
which the requesting runtime declares. The check therefore stops accidental
self-approval; it does not prove who asked, and a runtime that lies about the
requester can defeat it. Binding a signed requester identity is part of the
identity work that follows #4204.

## Audit record

With a policy configured, every governed decision appends one audit event to
the kernel graph:

- `APPROVAL_DECIDED` for an allowed decision, actor `operator:<id>`, with the
  decision and the role in `details`;
- `APPROVAL_RBAC_DENIED` for a refusal, with the refusal code and the role (if
  one was found) in `details`.

The audit entry is written before the decision proceeds. If the graph is
unavailable the refusal still stands and the response carries
`auditRecorded: false`, so a missing audit trail is visible rather than
silently allowing the action.

## Not in this slice

The following parts of #4205 remain open and are not implemented by this RBAC
slice:

- N-of-M quorum, including the second approver named in `README.md`;
- propagating the verified approver identity into the execution receipt.
  Today the identity is bound in the signed decision envelope and audit event;
  the receipt carries the approval id.

## Tests

`test/approval-rbac.test.js` covers the policy validator, every refusal code,
separation of duties on and off, and the docs matrix. The decision path is
exercised end to end in `test/authority-decision-path.integration.test.js`.
