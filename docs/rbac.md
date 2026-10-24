# Approval RBAC

Role-based approval authority (#4205). This page describes the opt-in role
policy, per-operator API-key identity, distinct-operator quorum, queue CLI, and
the signed evidence attached to the final execution receipt.
## Opt-in

RBAC is off until a policy file is named:

| Variable | Meaning |
| --- | --- |
| `HUQAN_RBAC_POLICY_PATH` | Path to the policy JSON. Unset: no RBAC, single-user behaviour is byte-identical to today. |
| `HUQAN_AUTHORITY_OPERATOR_ID` | Legacy single-operator identity, or the operator-id lookup hint paired with an API key; the hint is accepted only after the key verifies. Must match an `operators` key. |
| `HUQAN_AUTHORITY_API_KEY` | Per-operator random API credential used by the protected operator CLI. The policy stores only a scrypt verifier, not the raw key. |

`AXIOM_RBAC_POLICY_PATH`, `AXIOM_AUTHORITY_OPERATOR_ID`, and `AXIOM_AUTHORITY_API_KEY` are accepted as legacy environment aliases.

The policy is local configuration, not a signed document. It maps the identity
asserted by the authority to a role. Protecting the file is the deployment's
job; SSO (#4204) will change where the authority learns that identity, not this
mapping.

## Policy file

`config/rbac.example.json` is a complete, valid example. The schema is strict:
unknown fields, unknown permissions, an operator naming a role that does not
exist, or a malformed API-key hash/quorum make the policy invalid, and an
invalid policy refuses every decision.

```json
{
  "version": 1,
  "roles": {
    "approver": ["approvals.view", "approvals.decide"]
  },
  "operators": {
    "operator-1": "approver",
    "operator-2": "approver"
  },
  "separationOfDuties": false,
  "operatorApiKeyVerifiers": {},
  "quorum": {
    "default": 1,
    "byTool": {}
  }
}
```

### Distinct operator credentials and quorum

For multi-operator decisions, set operatorApiKeySalt to one random 16-byte
base64url value and operatorApiKeyVerifiers to a map from each operator id to
the scrypt verifier of that operator's 256-bit random API key. Reuse the same
policy salt for every operator so the validator can reject duplicate keys.
Generate the salt and independent keys/verifiers locally:

```powershell
node -e "const c=require('node:crypto'); const r=require('./lib/approval-rbac'); const s=r.createOperatorApiKeySalt(); console.log('operatorApiKeySalt='+s); for (const id of ['operator-1','operator-2']) { const k=c.randomBytes(32).toString('base64url'); console.log('HUQAN_AUTHORITY_OPERATOR_ID='+id); console.log('HUQAN_AUTHORITY_API_KEY='+k); console.log('operatorApiKeyVerifiers.'+id+'='+r.createOperatorApiKeyVerifier(k,s)); }"
```

Put only the salt and scrypt verifiers in the protected policy file; set each
raw key and its matching HUQAN_AUTHORITY_OPERATOR_ID in that operator's
protected environment. Restart the Authority after policy changes. When
API-key verifiers are configured, each decision must carry a recognized bearer
key plus the operator-id lookup hint; the Authority trusts the identity only
after the key verifies against that operator's scrypt verifier. The key is the
operator credential for this mode, so the shared legacy TOTP code is not
requested or consumed. Protect raw keys like passwords and never put them in
source control or logs.

`quorum.default` applies to all tools unless `quorum.byTool` overrides it.
A threshold above one is valid only when the policy contains at least that
many distinct API-key identities, each assigned a role with
`approvals.decide`. Votes are appended to the Authority ledger as one
`approval.vote` entry per approval and operator, bound to the approval id,
workspace, tool, action hash, decision, operator, the authentication method
(`authMethod`) and the policy fingerprint (`policyVersion`/`policyHash`).
Repeating the same vote is idempotent: the Authority answers `202` with
`idempotent: true` and writes nothing. Voting the opposite way after an
accepted vote is refused with `DUPLICATE_APPROVER` and recorded as an
`approval.vote_denied` entry, so neither repeat increases the count. An
explicit rejection vetoes the pending request. Approval is signed only after
the required number of distinct operators has approved; the envelope carries
the distinct `approverIds`, `quorumRequired`, and the `policyVersion` and
`policyHash` of the policy that required the threshold.

Permissions are a closed list: `approvals.view`, `approvals.decide`,
`approvals.manage`. The Authority enforces `approvals.decide` for each vote.
The local CLI queue currently remains readable without role gating; the
`approvals.view` permission is not presented as an enforced boundary yet.
Policy management is still an administrator-managed configuration file.

## Role matrix

Both roles and their permissions live in the policy file. The matrix below is
the shipped example, and `test/approval-rbac.test.js` fails if this table and
`config/rbac.example.json` diverge.

| Role | Permissions | Intended use |
| --- | --- | --- |
| `viewer` | none | Read-only queue role (not enforced by this Authority slice) |
| `operator` | `approvals.view` | Read the queue (view permission not yet enforced) |
| `approver` | `approvals.view`, `approvals.decide` | Approve or reject; `approvals.decide` is enforced |
| `admin` | `approvals.view`, `approvals.decide`, `approvals.manage` | Approve/reject; policy management remains file/OS-admin scoped |

## Approval queue CLI

`huqan approvals list` lists the same bounded, read-only approval queue as
`huqan approvals`; the existing spelling remains supported. Add
`--workspace <id>` to scope the queue to a workspace.

The command is operator-gated, but the policy permission `approvals.view` is
not yet enforced on the queue read path. The role matrix above describes the
configured policy; only `approvals.decide` is enforced in this slice.

## How a decision is authorized

1. The authority signs a decision envelope for one approval, workspace, tool
   and action hash. With `HUQAN_AUTHORITY_OPERATOR_ID` set in legacy single-user
   mode, or a recognized per-operator API key supplied for a decision, the
   envelope carries `operatorId` inside the signature.
2. The runtime verifies the envelope against the pinned key (ADR-016). An
   unsigned or foreign decision never reaches RBAC.
3. RBAC reads `operatorId` from the verified payload and looks up its role.
   The decision is allowed only when the role grants `approvals.decide`.

Refusals are total, with distinct codes:

| Code | Cause |
| --- | --- |
| `APPROVAL_RBAC_POLICY_INVALID` | The policy is missing, unreadable, or malformed. |
| `APPROVAL_RBAC_OPERATOR_REQUIRED` | A policy is configured but the identity source did not supply an operator id. |
| `APPROVAL_RBAC_OPERATOR_UNKNOWN` | The signed identity has no role. |
| `APPROVAL_RBAC_PERMISSION_DENIED` | The role exists but lacks `approvals.decide`. |
| `APPROVAL_RBAC_SEPARATION_OF_DUTIES` | The requester and the approver are the same identity, and separation of duties is on. |
| `APPROVAL_RBAC_API_KEY_REQUIRED` | This policy requires a per-operator API key. |
| `APPROVAL_RBAC_API_KEY_INVALID` | The presented API key does not match the hinted operator identity. |
| `QUORUM_REQUIRES_OPERATOR_API_KEYS` | Multi-operator quorum cannot use the shared legacy TOTP identity. |
| `DUPLICATE_APPROVER` | This operator already voted the opposite way on the approval; the attempt is recorded as `approval.vote_denied`. |

A refusal leaves the approval pending. It does not reject it and cannot be
retried into an approval without a new decision.

In legacy single-user mode, the authority uses the configured
`HUQAN_AUTHORITY_OPERATOR_ID` and TOTP flow. A multi-operator quorum refuses
closed unless distinct per-operator API-key verifiers are configured; callers
cannot supply an `operatorId` in the sealed request to choose their own role.

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

## Approval queue and receipt evidence

The CLI accepts both huqan onaylar and huqan approvals list (also
approvals queue). The text view includes the approval id, canonical tool,
declared origin, bounded claim summary, and time waiting. If the origin is not
known from recorded provenance, it is shown as unknown rather than inferred.
Use the --workspace option to scope the queue.

After an approved action runs, the runtime stores a portable
huqan.approval-decision-attestation.v1 sidecar alongside the original receipt.
It joins the Authority-signed decision envelope (including operatorId) to a
separately signed outcome that binds the exact receipt hash. The receipt bytes
are not modified. Existing receipts remain valid, and legacy decisions without
a person-level identity do not claim a named approver.

## Remaining boundary

This slice now counts distinct authenticated operators for N-of-M quorum,
recovers a quorum completed just before a process crash, and binds the signed
operator identity and exact decision-envelope digest to the outcome attestation
without rewriting the original receipt bytes. Each vote and each quorum
decision also name the policy that governed it by hash, so a later policy edit
cannot be read back onto an earlier approval. The huqan approvals list and
huqan onaylar aliases are covered by CLI tests.

Two policy permissions are still not enforced as runtime boundaries:
approvals.view does not gate queue reads, and approvals.manage has no
management API because the policy remains a protected local file. Do not treat
those role labels as authorization controls until a separate slice implements
and tests them.
## Tests

`test/approval-rbac.test.js` covers the policy validator, every refusal code,
separation of duties on and off, and the docs matrix. Receipt identity and
recovery are covered by `test/approval-decision-attestation.test.js` and the
end-to-end apply flow in `test/authority-apply-flow.integration.test.js`.
