# REFACTOR-1C3B - CLI Audit Event Contract

## Purpose

This gate defines the future bounded, intent-level Kernel seam that CLI
mutation paths will use instead of calling `Graph.appendAuditEvent()`
directly.

The future method is:

```javascript
recordCliMutationAudit(intent)
```

This is a contract-only gate. It does not implement the method, change a
declaration, add a test, migrate a CLI callsite, or alter runtime behavior.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch: `main`
- Required base: `4533e34190eee197e33153506c791bad0b2caa6c`
- Previous checkpoint: `REFACTOR-1C3A_CLOSEOUT_AUDIT_GREEN`
- Current gate: `REFACTOR-1C3B_AUDIT_EVENT_CONTRACT`
- Authorized successor after separate review, merge, and closeout:
  `REFACTOR-1C3C`

The implementation base for any successor must be separately authorized from
the then-current canonical `main`. This document's base is not a standing
implementation authorization.

## Governing Sources

The following files are source authority for this contract:

- `docs/task-packs/refactor-1c3-cli-audit-seam-source-reality.md`
- `cli.js`
- `kernel.js`
- `kernel.d.ts`
- `kernel.v2.js`
- `kernel.v2.d.ts`
- `graph.js`
- `lib/audit-log.js`
- `lib/audit-log.test.js`
- `lib/approval-schema.js`
- `lib/approval-flow.js`
- `lib/receipt/canonical-receipt.js`
- `test/kernel-facade-contract.test.js`
- `test/kernel-constructor-variant-contract.test.js`
- HUQAN Master Roadmap v3.2
- HUQAN Competitive Evidence and Design-Option Register

If this document and current source disagree, current source wins and the gate
must stop rather than silently broadening the contract.

## Governing Invariants

1. The public seam is intent-level and CLI-specific.
2. Generic Graph audit append behavior is not made public through Kernel.
3. Existing pre-execution timing and best-effort failure isolation remain the
   compatibility baseline.
4. Audit presence is not evidence of command execution or mutation success.
5. `details.executed` retains its persisted compatibility name while meaning
   authorization/execution eligibility only.
6. The method is synchronous and does not throw an audit failure into the CLI
   command path.
7. KernelV2 will delegate exactly once to its wrapped Kernel v1 instance.
8. Approval and receipt data remain optional and cannot create trust claims.
9. No atomicity or durability guarantee is introduced.
10. Runtime, declaration, test, and callsite work remain separately
    authorized successor gates.

## Source-Reality Boundary

At the canonical base:

- `CLI._auditCliMutation()` directly calls
  `kernel.graph.appendAuditEvent()`;
- the audit attempt occurs during gate evaluation and before command
  execution;
- the CLI ignores the normalized event returned by Graph;
- missing audit surfaces and thrown append errors do not replace the command
  result;
- Kernel v1 has only the private generic helper `_appendAuditEvent()`;
- KernelV2 exposes Graph through a compatibility getter but has no audit-intent
  method;
- no Kernel declaration or frozen facade contract includes an audit-intent
  method;
- interactive `kaydet`, `exit`, and `cikis` bypass the gate and audit helper;
- direct `execute('kaydet')` records an allow audit and then returns the
  unknown-command output.

These facts are baselines, not endorsements of direct Graph access or the
interactive bypasses.

## Public Method Contract

The future Kernel v1 method is exactly:

```javascript
recordCliMutationAudit(intent)
```

The method name does not exist at the canonical base and has no verified
semantic collision.

The method is:

- a bounded CLI mutation-audit seam;
- a synchronous pre-execution audit operation;
- a non-throwing best-effort wrapper around existing audit normalization and
  append behavior;
- the only intended Kernel-level entry for the later CLI callsite migration.

The method is not:

- a generic audit append method;
- a Graph adapter;
- an arbitrary event writer;
- a receipt writer or receipt validator;
- an approval executor;
- a mutation executor;
- an outcome or completion event writer.

## CliMutationAuditIntent

The future bounded input type is named `CliMutationAuditIntent`.

```typescript
type CliMutationAuditIntent = Readonly<{
  sourceCommand: string;
  mutationType:
    | 'persistence'
    | 'export'
    | 'state_replace'
    | 'canonical'
    | 'automation';
  eventType: 'UPDATE' | 'EXPORTED' | 'IMPORTED' | 'REVIEW';
  decision: 'allow' | 'review' | 'dry_run_only' | 'block';
  executionEligible: boolean;
  reason:
    | 'cli_persist_local'
    | 'cli_backup_export_local'
    | 'cli_restore_state_replace_local'
    | 'cli_canonical_mutation_requires_review'
    | 'cli_automation_requires_review';
  actor?: string;
  workspaceId?: string;
  approvalState?:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'cancelled';
  receiptReference?: string;
}>;
```

`sourceCommand` is the normalized command token used by the current CLI gate,
not the raw input line. For example, the `dusun basla` path uses `dusun` as
the source command because that is the current audited command and target ID.

`executionEligible` must equal `true` only when the decision is `allow` for
the bounded CLI mappings in this contract. Other decision values map to
`false`. It is not a statement about completion.

## Field Classification

Every accepted intent field has exactly one classification:

| Intent field | Classification | Contract |
| --- | --- | --- |
| `sourceCommand` | `CALLER_REQUIRED` | Non-empty normalized command token from the authorized mapping table |
| `mutationType` | `CALLER_REQUIRED` | One bounded mutation type from `CliMutationAuditIntent` |
| `eventType` | `CALLER_REQUIRED` | One bounded event type and consistent with the mapping table |
| `decision` | `CALLER_REQUIRED` | Existing gate/approval verdict vocabulary; no new decision value |
| `executionEligible` | `CALLER_REQUIRED` | Boolean authorization eligibility; must be consistent with `decision` |
| `reason` | `CALLER_REQUIRED` | One existing CLI gate reason from the bounded union |
| `actor` | `CALLER_OPTIONAL` | Non-empty authorized actor string; omission uses the existing CLI actor |
| `workspaceId` | `CALLER_OPTIONAL` | Non-empty workspace identifier; omission uses existing default behavior |
| `approvalState` | `CALLER_OPTIONAL` | Existing approval-request status only |
| `receiptReference` | `CALLER_OPTIONAL` | Non-empty existing `receiptId` string only; not a receipt payload |

The resulting normalized audit fields have these classifications:

| Normalized field | Classification | Contract |
| --- | --- | --- |
| `auditId` | `KERNEL_DERIVED` | Generated by existing audit normalization; forbidden in caller input |
| `timestamp` | `KERNEL_DERIVED` | Generated by existing audit normalization; forbidden in caller input |
| `eventType` | `KERNEL_DERIVED` | Copied only after bounded intent validation |
| `targetType` | `FIXED_CONSTANT` | Always `cli_mutation` |
| `targetId` | `KERNEL_DERIVED` | Derived from `sourceCommand` |
| `workspaceId` | `KERNEL_DERIVED` | Validated optional value or existing `default` fallback |
| `actor` | `KERNEL_DERIVED` | Validated optional value or fixed existing CLI actor `cli-user` |
| `sourceRef` | `KERNEL_DERIVED` | Existing normalization default; caller cannot provide it |
| `provenanceId` | `KERNEL_DERIVED` | Existing normalization default; caller cannot provide it |
| `trustPolicyVersion` | `KERNEL_DERIVED` | Existing normalization default; caller cannot provide it |
| `details.source` | `FIXED_CONSTANT` | Always `cli` |
| `details.command` | `KERNEL_DERIVED` | Derived from `sourceCommand` |
| `details.mutationType` | `KERNEL_DERIVED` | Derived from validated `mutationType` |
| `details.decision` | `KERNEL_DERIVED` | Derived from validated `decision` |
| `details.executed` | `KERNEL_DERIVED` | Derived from validated `executionEligible` |
| `details.reason` | `KERNEL_DERIVED` | Derived from validated `reason` |
| `details.approvalState` | `KERNEL_DERIVED` | Included only when validated optional input is present |
| `details.receiptId` | `KERNEL_DERIVED` | Included only from validated `receiptReference` |

The following are `FORBIDDEN` in caller input:

- `auditId`;
- `timestamp`;
- arbitrary `targetType` or `targetId`;
- arbitrary normalized persistence fields;
- `sourceRef`, `provenanceId`, or `trustPolicyVersion` overrides;
- raw Graph options;
- raw provenance objects;
- generic audit-event payloads;
- nested receipt payloads;
- arbitrary `details` objects.

Unknown top-level intent fields, invalid combinations, or forbidden fields are
normalization failures and must produce the bounded failure result. They must
not be forwarded to Graph.

## Normalized Event Mapping

After validating the intent, Kernel constructs only this event boundary:

```javascript
{
  eventType: intent.eventType,
  targetType: 'cli_mutation',
  targetId: intent.sourceCommand,
  actor: intent.actor || 'cli-user',
  workspaceId: intent.workspaceId || 'default',
  details: {
    source: 'cli',
    command: intent.sourceCommand,
    mutationType: intent.mutationType,
    decision: intent.decision,
    executed: intent.executionEligible,
    reason: intent.reason,
    // approvalState only when supplied
    // receiptId only when receiptReference is supplied
  },
}
```

Existing audit normalization remains responsible for `auditId`, `timestamp`,
JSON-safe cloning, and the normalized persistence shape.

## Approval and Receipt Boundaries

`approvalState` reuses the stable `APPROVAL_REQUEST_STATUSES` vocabulary:

```text
pending
approved
rejected
expired
cancelled
```

The field is optional. Its absence means only that no approval state was
attached to this audit intent. Its presence records a supplied existing state;
it does not execute or validate approval.

`receiptReference` is an optional non-empty string that refers only to an
existing `receiptId`. Kernel maps it to `details.receiptId`. It is not a
receipt object, canonical receipt payload, receipt signature, or schema
extension. Kernel does not create, resolve, validate, or modify a receipt in
this method.

Absence or presence of either optional field must not imply:

- approval;
- authorization beyond the recorded gate decision;
- safety;
- execution success;
- receipt validity;
- verified outcome.

## Event Phase Semantics

This contract records the current pre-execution gate/audit phase:

```text
audit presence != mutation success
details.executed == authorization/execution eligibility
details.executed != completed
details.executed != persisted
details.executed != verified outcome
```

No completion, failure-outcome, persistence-confirmation, or compensating
event is introduced. A future multi-phase audit lifecycle requires separate
roadmap authorization.

## Return Contract

The future return type is named `CliMutationAuditResult`:

```typescript
type CliMutationAuditResult = Readonly<{
  auditRecorded: boolean;
  event: NormalizedAuditEvent | null;
  errorCode: null | 'AUDIT_WRITE_FAILED';
}>;
```

Successful normalization and append return:

```javascript
{
  auditRecorded: true,
  event: normalizedAuditEvent,
  errorCode: null,
}
```

Intent validation, normalization, missing audit surface, or append failure
return:

```javascript
{
  auditRecorded: false,
  event: null,
  errorCode: 'AUDIT_WRITE_FAILED',
}
```

The method is synchronous. It must not throw an audit failure into the caller.
No logging behavior is guaranteed by this public contract.

The audit result never redefines the CLI command result. The later CLI
migration may ignore this result to preserve current output and command-flow
behavior.

## KernelV2 Contract

KernelV2 will later implement the exact same public method and delegate once
to its wrapped Kernel v1 instance:

```javascript
recordCliMutationAudit(intent) {
  return this.kernel.recordCliMutationAudit(intent);
}
```

Required future behavior:

- same input object;
- same synchronous timing;
- same return shape and value;
- same best-effort failure isolation;
- no direct Graph access exposed;
- exactly one Kernel v1 invocation;
- exactly one audit append per invocation;
- no duplicate append through delegation.

This gate does not implement or test that delegation.

## Event Mapping Table

All future intent values below use the bounded contract. The 1C3B and 1C3C
gates do not change current behavior.

| CLI path | Current behavior | Future intent input | Event / decision / `details.executed` | Migrated in 1C3E | Compatibility boundary |
| --- | --- | --- | --- | --- | --- |
| `backup` | Pre-execution direct Graph audit, then backup | `backup`, `export`, `cli_backup_export_local` | `EXPORTED` / `allow` / `true` | Yes | Preserve command output, audit-before-command ordering, and later-failure distinction |
| `restore` | Pre-execution direct Graph audit, then restore and reload | `restore`, `state_replace`, `cli_restore_state_replace_local` | `IMPORTED` / `allow` / `true` | Yes | Preserve restore/reload ordering and command output |
| `optimize` | Pre-execution review audit; command short-circuits | `optimize`, `canonical`, `cli_canonical_mutation_requires_review` | `REVIEW` / `review` / `false` | Yes | Preserve review block and no optimize invocation |
| `evolve` | Pre-execution review audit; command short-circuits | `evolve`, `canonical`, `cli_canonical_mutation_requires_review` | `REVIEW` / `review` / `false` | Yes | Preserve review block and no evolution invocation |
| `konsolide` | Pre-execution review audit; command short-circuits | `konsolide`, `canonical`, `cli_canonical_mutation_requires_review` | `REVIEW` / `review` / `false` | Yes | Preserve review block and no consolidation invocation |
| `dusun basla` | `dusun` receives a pre-execution review audit; command short-circuits | `dusun`, `automation`, `cli_automation_requires_review` | `REVIEW` / `review` / `false` | Yes | Preserve normalized command token, review block, and no auto-think start |
| interactive `kaydet` | Bypasses gate/audit, persists, prints success | `kaydet`, `persistence`, `cli_persist_local` | `UPDATE` / `allow` / `true` | Yes | Bypass remains baseline through 1C3C; 1C3E may add the seam while preserving persist/output ordering |
| interactive `exit` | Bypasses gate/audit, persists, prints exit output, closes readline | `exit`, `persistence`, `cli_persist_local` | `UPDATE` / `allow` / `true` | Yes | Bypass remains baseline through 1C3C; 1C3E must preserve persist/output/close ordering |
| interactive `cikis` | Same bypass and persistence behavior as `exit` | `cikis`, `persistence`, `cli_persist_local` | `UPDATE` / `allow` / `true` | Yes | Preserve alias identity and interactive ordering |
| direct `execute('kaydet')` | Pre-execution allow audit, then unknown-command output | `kaydet`, `persistence`, `cli_persist_local` | `UPDATE` / `allow` / `true` | Yes | Replace only audit routing; preserve the current unknown-command result unless separately authorized |

This table does not fix bypasses or direct-execute inconsistencies in 1C3B.
It defines the bounded inputs that a separately authorized 1C3E migration must
use.

## Failure and Durability Contract

The future seam preserves:

- best-effort audit write;
- audit failure isolation from command outcome;
- synchronous call timing;
- the current pre-execution phase;
- no atomicity claim;
- no durability claim beyond the existing audit implementation.

The contract explicitly prohibits these claims:

- audit and mutation are atomic;
- audit presence proves execution;
- audit presence proves successful mutation;
- audit presence proves persistence;
- audit presence proves approval;
- audit presence proves receipt validity;
- the in-memory and SQLite durability boundaries are identical;
- command failure updates or compensates the pre-execution audit event.

## Competitive register rows consulted

### RTG-009

```text
REGISTER ENTRY:
RTG-009

EVIDENCE SOURCE / SHA:
HUQAN_Competitive_Reverse_Engineering_Cumulative_2026-07-18_v3.zip
d1630dac532d4566c50cc8ca8dbdbaeaeba8ad2b24457a886263a510f4f8ca8b

CURRENT HUQAN SOURCE / SHA:
ali-ulu/huqan
4533e34190eee197e33153506c791bad0b2caa6c

DECISION:
CONTRACT INPUT; CLOSURE DEFERRED

MAPPED ROADMAP GATE:
ACTION INTEGRITY F5 / MEMORY + PROVENANCE J3

REASON:
The current CLI appends pre-execution audit evidence outside the mutation's
durability boundary. This contract must retain that limitation explicitly.

REQUIRED TEST / EVIDENCE:
Current failure-isolation baseline evidence in 1C3C, then later fault
injection, crash/recovery, and durability-boundary evidence in F5 / J3.

REVISIT TRIGGER:
REFACTOR-1C3C baseline review, REFACTOR-1C3D seam review, or later F5 / J3
scope definition.

OWNER:
REFACTOR-1C3C baseline owner, then future F5 / J3 gate owner.

STATUS:
CONTRACT INPUT / OPEN
```

### CE-010

```text
REGISTER ENTRY:
CE-010

EVIDENCE SOURCE / SHA:
HUQAN_Competitive_Reverse_Engineering_Cumulative_2026-07-18_v3.zip
d1630dac532d4566c50cc8ca8dbdbaeaeba8ad2b24457a886263a510f4f8ca8b

CURRENT HUQAN SOURCE / SHA:
ali-ulu/huqan
4533e34190eee197e33153506c791bad0b2caa6c

DECISION:
ADAPT

MAPPED ROADMAP GATE:
ACTION INTEGRITY F5 / J3 PROVENANCE LEDGER / ENTERPRISE AUDIT EXPORT

REASON:
The future intent-level seam must not imply that audit append and mutation
share a safe durability boundary.

REQUIRED TEST / EVIDENCE:
Explicit append/failure contract evidence, fault injection, recovery evidence,
and negative tests proving that audit presence is not mutation success.

REVISIT TRIGGER:
REFACTOR-1C3D seam review, ACTION INTEGRITY F5, or J3 Provenance Ledger scope
definition.

OWNER:
REFACTOR-1C3D contract owner, then future F5 / J3 gate owner.

STATUS:
ADAPT / OPEN
```

`RTG-006` remains `OBSERVED / OPEN` from REFACTOR-1C3A. This event-contract
gate does not close CLI visibility, invocation, startup, or mutation-coverage
parity.

`CE-009` is not a direct register row for this gate. It concerns approval
execution crash/replay idempotency, not audit durability. It is not substituted
for `CE-010`.

## REFACTOR-1C3C Baseline Test Ownership

REFACTOR-1C3C may create only tests that pass against the current canonical
source without `recordCliMutationAudit()`.

The exact future baseline owner is:

```text
test/kernel-cli-audit-baseline-contract.test.js
```

Its authorized categories are:

1. Existing CLI input-to-event mappings for currently audited paths.
2. Current event fields: command, mutation type, decision, reason, and the
   current `details.executed` meaning.
3. Current fixed/derived baselines: `targetType = cli_mutation`, target ID from
   command, `details.source = cli`, and details command from command.
4. Source assertions that CLI intent does not originate `auditId`, timestamp,
   arbitrary target type, or arbitrary normalized persistence fields.
5. Current failure isolation when the audit surface is missing or append
   throws.
6. Command-result isolation from audit presence and failure.
7. Explicit negative semantics for `details.executed`: not completion,
   persistence, or verified outcome.
8. Current interactive `kaydet`, `exit`, and `cikis` bypasses.
9. Current direct `execute('kaydet')` inconsistency.
10. Current pre-execution audit ordering.

REFACTOR-1C3C must not require:

- `recordCliMutationAudit()` existence;
- the new normalized seam return;
- KernelV2 delegation;
- declaration or facade entries;
- future no-duplicate behavior;
- removal of CLI Graph access;
- any deliberately red assertion for the missing method.

## REFACTOR-1C3D Runtime and Delegation Ownership

REFACTOR-1C3D owns the runtime seam and every test that depends on that seam.

The exact future seam owner is:

```text
test/kernel-cli-audit-seam-contract.test.js
```

REFACTOR-1C3D owns:

1. `recordCliMutationAudit()` runtime existence.
2. Exact bounded-intent acceptance and forbidden-field rejection.
3. Normalized success return.
4. Normalized failure return with `AUDIT_WRITE_FAILED`.
5. Non-throwing best-effort failure isolation.
6. KernelV2 exact delegation to Kernel v1.
7. Same input and synchronous result semantics across variants.
8. Exactly one append per invocation.
9. No duplicate append through KernelV2 delegation.
10. No public generic Graph audit surface.
11. No exposure of Kernel `_appendAuditEvent()`.
12. `kernel.d.ts` parity.
13. `kernel.v2.d.ts` parity.
14. Kernel facade contract parity.
15. Kernel constructor-variant/delegation contract coverage.

The two ownership sections do not overlap: 1C3C locks current source behavior;
1C3D introduces and tests the future seam.

## REFACTOR-1C3E Migration Boundary

Only after 1C3D closes may REFACTOR-1C3E replace direct CLI Graph access and
migrate the authorized mapping-table callsites.

1C3E must preserve command output, gate decisions, synchronous ordering,
mutation ordering, failure isolation, and the direct `execute('kaydet')`
result unless a separate behavior-change gate explicitly authorizes otherwise.

## Allowed Scope

This gate may add only:

```text
docs/task-packs/refactor-1c3b-cli-audit-event-contract.md
```

## Forbidden Scope

This gate must not modify:

- `cli.js`;
- `kernel.js`;
- `kernel.v2.js`;
- `graph.js`;
- `kernel.d.ts`;
- `kernel.v2.d.ts`;
- any test file;
- `lib/audit-log.js`;
- approval or receipt schemas;
- server or MCP code;
- package files;
- workflows;
- roadmap files.

This gate must not:

- implement `recordCliMutationAudit()`;
- expose `_appendAuditEvent()`;
- expose `Graph.appendAuditEvent()`;
- add a generic graph-operation API;
- create deliberately red tests;
- start REFACTOR-1C3C, 1C3D, or 1C3E;
- change command output, timing, persistence, or audit behavior;
- claim atomicity or durability.

## Acceptance Criteria

1. Exactly one new docs/task-pack file changes.
2. The canonical base is exact.
3. The method name and bounded intent signature are explicit.
4. Every accepted input field has exactly one classification.
5. Caller-forbidden fields are explicit.
6. Fixed target and derived detail fields are explicit.
7. Persisted `details.executed` semantics are preserved and clarified.
8. Approval vocabulary reuses existing stable values.
9. Receipt reference reuses only the optional `receiptId` string boundary.
10. Return and non-throwing failure-isolation contracts are exact.
11. KernelV2 delegation and no-duplicate invariants are defined but not
    implemented or tested in this gate.
12. Current behavior and future migration are separated.
13. RTG-009 and CE-010 are directly evaluated and remain open.
14. RTG-006 remains open and CE-009 is not substituted for CE-010.
15. REFACTOR-1C3C owns only tests that can pass against current canonical
    source without the future intent-level Kernel method.
16. REFACTOR-1C3D owns method existence, return shape, declarations, facade,
    KernelV2 delegation, no-duplicate, and Graph-boundary tests.
17. No runtime, declaration, test, schema, package, workflow, or roadmap file
    changes.
18. `git diff --check` passes.
19. The worktree is clean after commit.

## Validation

Run:

```bash
git rev-parse HEAD
git status --short
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD

git grep -n "recordCliMutationAudit" -- \
  docs/task-packs/refactor-1c3b-cli-audit-event-contract.md

git grep -nE "RTG-009|CE-010|CE-009|RTG-006" -- \
  docs/task-packs/refactor-1c3b-cli-audit-event-contract.md
```

Expected changed file:

```text
docs/task-packs/refactor-1c3b-cli-audit-event-contract.md
```

No local runtime test is required for this docs-only gate. Previous test totals
must not be reported as new-head evidence.

## Commit and Review Lifecycle

Commit message:

```text
docs: define CLI audit event contract
```

Required trailer:

```text
Signed-off-by: Ali ULU <aliulu@ai-ulu.com>
```

Push the dedicated branch and open a draft PR. Do not merge, enable
auto-merge, or begin a successor gate.

Successful handoff verdict:

```text
REFACTOR-1C3B_AUDIT_EVENT_CONTRACT_READY_FOR_INDEPENDENT_READ_ONLY_REVIEW
```

## Stop Conditions

Stop and report instead of broadening scope if:

- canonical `main` differs from the required base;
- the method name collides with existing behavior;
- approval or receipt vocabulary cannot be reused safely;
- a receipt-schema change is required;
- runtime, declaration, or test modification is required;
- the one-file scope cannot be preserved;
- `git diff --check` fails;
- CI fails.

Failure verdict:

```text
REFACTOR-1C3B_BLOCKED_CONTRACT_CONFLICT
```

## Non-Claims

This document does not claim that:

- the future method exists;
- KernelV2 delegates audit intent;
- CLI no longer accesses Graph directly;
- interactive audit bypasses are fixed;
- audit records prove execution, persistence, approval, receipt validity, or
  successful mutation;
- audit and mutation are atomic;
- current audit storage has a stronger durability guarantee;
- REFACTOR-1C3C, 1C3D, or 1C3E is authorized or started.
