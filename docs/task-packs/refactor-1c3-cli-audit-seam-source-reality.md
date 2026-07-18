# REFACTOR-1C3A CLI Audit Seam Source Reality

## Purpose

Record the exact current-source behavior of CLI mutation audit handling before
any public Kernel audit contract, test, implementation, or CLI migration is
designed. This task-pack separates observed behavior from inference and
unverified product decisions.

This gate changes no runtime, test, declaration, package, workflow, or public
API.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch: `main`
- Source-reality base:
  `0dbf34bec86696db228b5057834c4602aba0b4a4`
- Previous checkpoint:
  `REFACTOR-1C2E_SOURCE_BOUNDARY_AND_CLOSEOUT_AUDIT_GREEN_ACCEPTED`
- Current gate:
  `REFACTOR-1C3A_AUDIT_SOURCE_REALITY`
- Authorized successor after separate closeout and approval:
  `REFACTOR-1C3B_AUDIT_EVENT_CONTRACT`

The base records the exact source inspected by this document. It is not an
implementation authorization.

## Governing Sources

- `cli.js`
- `cli.test.js`
- `graph.js`
- `graph.test.js`
- `kernel.js`
- `kernel.d.ts`
- `kernel.v2.js`
- `kernel.v2.d.ts`
- `lib/audit-log.js`
- `lib/audit-log.test.js`
- `lib/conflict-detector.js`
- `lib/github-connector.js`
- `test/faz2-cli-gate-parity.contract.test.js`
- `test/faz2-rest-cli-mutation-gate-parity.test.js`
- `test/faz2-background-write-gate-audit.test.js`
- `test/faz2-plugin-write-isolation.test.js`
- `test/kernel-facade-contract.test.js`
- `test/kernel-constructor-variant-contract.test.js`
- `docs/refactor/kernel-facade-contract.md`
- `docs/task-packs/refactor-1c-cli-graph-internal-coupling-scope.md`
- `docs/task-packs/refactor-1c2-kernel-lifecycle-maintenance-seam-scope.md`

## Competitive register rows consulted

The governing register is HUQAN Master Roadmap v3.2,
`Competitive Reverse-Engineering Evidence & Design-Option Register`.

This source-reality gate consults the following directly relevant records. It
produces source evidence for them but does not close them, authorize their
implementation, or change the roadmap sequence.

### RTG-006

```text
REGISTER ENTRY:
RTG-006

EVIDENCE SOURCE / SHA:
HUQAN_Competitive_Reverse_Engineering_Cumulative_2026-07-18_v3.zip
d1630dac532d4566c50cc8ca8dbdbaeaeba8ad2b24457a886263a510f4f8ca8b

CURRENT HUQAN SOURCE / SHA:
ali-ulu/huqan
0dbf34bec86696db228b5057834c4602aba0b4a4

DECISION:
ADAPT AS SOURCE-REALITY INPUT; CLOSURE DEFERRED

MAPPED ROADMAP GATE:
REFACTOR-4 / PRODUCTIZATION H0

REASON:
The current source distinguishes interactive command visibility, direct
execute invocation, mutation-gate coverage, audit invocation, and startup-path
bypasses. These surfaces must not be treated as equivalent.

REQUIRED TEST / EVIDENCE:
Separate visibility, invocation, startup, and mutation-coverage contracts plus
bypass-negative tests.

REVISIT TRIGGER:
REFACTOR-4 surface-parity scope definition or PRODUCTIZATION H0 gateway scope.

OWNER:
Future REFACTOR-4 / H0 gate owner.

STATUS:
OBSERVED / OPEN
```

### RTG-009

```text
REGISTER ENTRY:
RTG-009

EVIDENCE SOURCE / SHA:
HUQAN_Competitive_Reverse_Engineering_Cumulative_2026-07-18_v3.zip
d1630dac532d4566c50cc8ca8dbdbaeaeba8ad2b24457a886263a510f4f8ca8b

CURRENT HUQAN SOURCE / SHA:
ali-ulu/huqan
0dbf34bec86696db228b5057834c4602aba0b4a4

DECISION:
ADAPT AS SOURCE-REALITY INPUT; CLOSURE DEFERRED

MAPPED ROADMAP GATE:
ACTION INTEGRITY F5 / MEMORY + PROVENANCE J3

REASON:
The current CLI appends audit evidence before allowed mutations execute, audit
failure is isolated from command execution, and mutation plus audit durability
is not proven within one atomic boundary.

REQUIRED TEST / EVIDENCE:
Fault injection, crash/recovery evidence, and explicit durability/atomicity
boundary tests.

REVISIT TRIGGER:
REFACTOR-1C3B contract definition and later F5/J3 implementation scope.

OWNER:
Future F5 / J3 gate owner.

STATUS:
OBSERVED / OPEN
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
0dbf34bec86696db228b5057834c4602aba0b4a4

DECISION:
ADAPT

MAPPED ROADMAP GATE:
ACTION INTEGRITY F5 / J3 PROVENANCE LEDGER / ENTERPRISE AUDIT EXPORT

REASON:
The source-reality evidence confirms that an audit append and the associated
mutation do not currently share a proven safe durability boundary. The future
contract must preserve this limitation and must not invent atomicity or
durability claims.

REQUIRED TEST / EVIDENCE:
Explicit append/durability contract, fault injection, recovery evidence, and
negative tests proving that audit presence is not treated as mutation success.

REVISIT TRIGGER:
REFACTOR-1C3B contract review, ACTION INTEGRITY F5, or J3 Provenance Ledger
scope definition.

OWNER:
REFACTOR-1C3B contract owner, then future F5 / J3 gate owner.

STATUS:
CONTRACT INPUT / OPEN
```

`CE-009` is not listed as a directly consulted row in this gate. It concerns
approval execution atomicity/idempotency and crash/replay side effects. The
direct audit-durability design-option record for this task-pack is `CE-010`.

## Governing Invariants

The following invariants remain binding:

1. No behavior change in this gate.
2. Package entry and existing Kernel facade identity remain unchanged.
3. Graph compatibility access is not promoted into a new stable mutation API.
4. The private `Kernel._appendAuditEvent()` helper is not made public.
5. Existing CLI gate decisions, output text, and command ordering are recorded,
   not corrected.
6. Audit failure must not be described as mutation failure under current CLI
   behavior.
7. Audit success must not be described as proof that the mutation succeeded.
8. KernelV2 behavior is recorded but no delegation contract is invented.
9. No trust, authorization, approval, receipt, atomicity, or durability claim is
   inferred from the existence of an audit event.

## Current CLI Audit Call Graph

Observed call flow for commands that reach `CLI.execute()`:

```text
CLI.execute(command, args)
  -> CLI._evaluateCliGate(command, args)
       -> MCP tool gate, when a command maps to an MCP tool
       -> otherwise CLI._evaluateCliMutationGate(command, args)
            -> classify with CLI_MUTATION_GATE
            -> special-case `dusun dur` as allow/non-mutation
            -> compute canExecute from decision
            -> for mutationType != none:
                 CLI._auditCliMutation(..., executed = canExecute)
                   -> kernel.graph.appendAuditEvent(event, {})
                   -> ignore returned normalized event
                   -> swallow missing graph/method and thrown errors
            -> return gate result
  -> if gate result exists and canExecute is false:
       return formatted gate message
  -> otherwise run the command switch
```

The audit attempt therefore occurs during gate evaluation, before the command
switch and before the mutation result is known.

Observed interactive exceptions in `CLI.start()`:

```text
parsed `kaydet`
  -> kernel.persist()
  -> success output
  -> does not call execute(), mutation gate, or audit helper

parsed `exit` or `cikis`
  -> kernel.persist()
  -> success output
  -> readline close
  -> does not call execute(), mutation gate, or audit helper
```

The Turkish and ASCII exit aliases normalize to the interactive `cikis` or
`exit` branches. The direct `execute()` method has no equivalent exit case.

## Command Coverage Matrix

The table distinguishes the canonical interactive path from direct calls to
`execute()` where they differ.

| Command/path | Runtime path | Gate classification | Decision / canExecute | Audit attempt | Event type | Current `executed` value | Mutation and observable output |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `kaydet` in `CLI.start()` | Interactive special branch | Bypassed | Not evaluated | No | None | Absent | Calls `kernel.persist()` and prints save success; thrown errors are not converted into audit records |
| direct `execute('kaydet')` | Gate then command switch | persistence | allow / true | Yes, before switch | `UPDATE` | `true` | No `kaydet` switch case exists; returns unknown-command output after an audit event |
| `backup` | `execute()` | export | allow / true | Yes, before backup | `EXPORTED` | `true` | Calls `createBackup()`; success output contains directory and copied count; later failure does not revise the event |
| `restore` | `execute()` | state replacement | allow / true | Yes, before restore | `IMPORTED` | `true` | Calls `restoreBackup()`, then `kernel.reload()`; later failure does not revise the event |
| `optimize` | `execute()` | canonical mutation | review / false | Yes | `REVIEW` | `false` | Short-circuits to gate message; `kernel.optimize()` is not called |
| `evolve` | `execute()` | canonical mutation | review / false | Yes | `REVIEW` | `false` | Short-circuits; `kernel.selfEvolve()` is not called |
| `konsolide` | `execute()` | canonical mutation | review / false | Yes | `REVIEW` | `false` | Short-circuits; consolidate dry-run and mutation are not called |
| `dusun basla` | `execute()` | automation mutation | review / false | Yes | `REVIEW` | `false` | Short-circuits; `kernel.startAutoThink()` is not called |
| `dusun dur` | `execute()` special case | none/control | allow / true | No | None | Absent | Calls `kernel.stopAutoThink()` and returns stop output |
| `ruya` | `execute()` | none/read-only inference | allow / true | No | None | Absent | Calls dream inference and formats hypotheses |
| `exit` in `CLI.start()` | Interactive special branch | Bypassed | Not evaluated | No | None | Absent | Persists, prints exit output, and closes readline |
| `cikis` in `CLI.start()` | Interactive special branch | Bypassed | Not evaluated | No | None | Absent | Same interactive behavior as `exit` |
| direct `execute('exit')` or `execute('cikis')` | Gate then command switch | Unclassified | No gate result | No | None | Absent | No switch case exists; returns unknown-command output |

The direct `execute('kaydet')` behavior is source reality, not a recommended
consumer path. The interactive bypasses are also source reality, not evidence
that persistence operations are outside future audit policy.

## Current Event Shape

`CLI._auditCliMutation()` supplies this pre-normalization event:

```javascript
{
  eventType: classification.auditEvent ||
    (decision === 'allow' ? 'UPDATE' : 'REVIEW'),
  targetType: 'cli_mutation',
  targetId: command,
  actor: 'cli-user',
  details: {
    source: 'cli',
    command,
    mutationType: classification.mutationType,
    decision,
    executed,
    reason: classification.reason,
  },
}
```

It passes an empty options object to `graph.appendAuditEvent(event, {})`.

`lib/audit-log.js` then normalizes the event into:

```text
auditId
eventType
targetType
targetId
workspaceId
actor
timestamp
sourceRef
provenanceId
trustPolicyVersion
details
```

For the current CLI call:

- `auditId` is a new random UUID unless the input supplied one; CLI does not.
- `timestamp` is current wall-clock ISO time unless supplied; CLI does not
  supply one.
- `workspaceId` falls back to `default`.
- `actor` is `cli-user` from the event.
- `sourceRef`, `provenanceId`, and `trustPolicyVersion` fall back to empty
  strings.
- `details` is converted to a JSON-safe clone.
- no approval identifier, receipt identifier, mutation result, error, or final
  outcome is included.

The returned normalized event is ignored by the CLI.

## Timing Semantics

Observed ordering for classified mutation commands is:

```text
classification
-> decision/canExecute
-> audit attempt
-> gate return
-> optional command execution
-> optional command output or thrown error
```

Consequences of the observed ordering:

- Review decisions are audited before execution is denied.
- Allow decisions are audited before the operation starts.
- `details.executed` equals `canExecute`; it does not mean completed,
  persisted, or successful.
- Backup or restore can fail after an event with `executed: true` was appended.
- There is no current completion/update event that revises the pre-execution
  record.
- Audit append and the mutation are not one atomic operation.

## Failure Semantics

Current CLI audit failure isolation is best-effort and silent:

```text
missing kernel or graph
  -> no audit, no error

missing graph.appendAuditEvent
  -> no audit, no error

appendAuditEvent throws
  -> error swallowed by CLI
  -> command gate/execution continues

appendAuditEvent returns a value
  -> value ignored
```

This means current command execution is intentionally not blocked by audit
failure. It does not establish that silent failure is the desired future public
contract. REFACTOR-1C3B must decide the bounded observable result, if any,
without changing the existing command result envelope accidentally.

## Graph Audit Contract Reality

`Graph.appendAuditEvent(event, opts)` currently:

1. normalizes the event with `buildAuditEvent()`;
2. appends the normalized object to in-memory `_auditEvents`;
3. when SQLite is open, executes `INSERT OR IGNORE` against `audit_log`;
4. returns the normalized event;
5. does not catch normalization or persistence errors.

Additional boundaries:

- SQLite writes occur immediately through the prepared statement and outside
  an explicit transaction in this method.
- JSON persistence is not performed by `appendAuditEvent()` itself; a later
  `graph.save()` serializes in-memory audit events.
- SQLite append-only triggers reject updates and deletes, while duplicate
  `audit_id` values are ignored by insertion.
- Because CLI generates a fresh UUID per attempt, semantic duplicates are not
  deduplicated by command, reason, or timestamp.
- After Graph close, the in-memory append can still occur while SQLite writing
  is skipped because the database handle is absent.

The generic Graph method is an existing compatibility mutation surface. This
document does not bless direct Graph mutation as the future CLI public seam.

## Existing Kernel Audit Reality

Kernel v1 has a private helper:

```text
_appendAuditEvent(event, provenance = null, workspaceId = 'default')
```

It delegates to `graph.appendAuditEvent()` with provenance/workspace options,
returns the normalized event on success, and on failure logs a Kernel audit
error then returns `null`.

Observed caller families include:

- learn admission reject/review/allow outcomes;
- background node and edge admission;
- learned, reaffirmed, derived, and cross-link edges;
- plugin/background write paths;
- conflict detector and GitHub connector helpers that prefer the private
  Kernel helper when available and otherwise accept a Graph append surface.

This helper has broader provenance/workspace handling and different error
observability from the CLI's silent helper. It remains private and is absent
from the public facade/type contract. REFACTOR-1C3B may define reuse of internal
normalization/delegation behavior, but must not expose this generic private
method as the public CLI contract.

## KernelV2 Disposition

KernelV2 wraps Kernel v1 and exposes its Graph through a compatibility getter.
It has no audit-intent method and no explicit audit delegation contract.

Current indirect access to `kernelV2.graph.appendAuditEvent()` is not a public
intent-level API. Whether a future audit seam is delegated by KernelV2, and
with what exact return/error contract, belongs to REFACTOR-1C3B and later
runtime/test gates.

## Type/Facade Reality

At this base:

- `kernel.d.ts` contains no public audit-intent method.
- `kernel.v2.d.ts` contains no public audit-intent method.
- the frozen public method list in
  `test/kernel-facade-contract.test.js` contains no audit-intent method.
- `graph` remains a limited compatibility surface in the Kernel declaration;
  `appendAuditEvent()` is not declared there.
- no package-entry audit facade is established.

Therefore a public Kernel audit seam is absent in runtime, declarations, and
facade contract tests.

## Test Ownership Map

| Current or future owner | Current evidence | Missing or future responsibility |
| --- | --- | --- |
| `test/faz2-cli-gate-parity.contract.test.js` | Mutation classifications, allow/review decisions, and audit presence | Exact normalized event, timing, final-outcome distinction, and failure isolation |
| `test/faz2-rest-cli-mutation-gate-parity.test.js` | Backup/restore event types, review blocking, read-only dream classification | Exact audit details and mutation-failure-after-audit behavior |
| `cli.test.js` | Parsing, backup/restore, interactive save/exit ordering, optimize behavior | Interactive audit bypass baseline and future migrated callsite behavior |
| `lib/audit-log.test.js` | Normalization, defaults, provenance, in-memory append, filters, SQLite persistence | No ownership of CLI intent semantics |
| `graph.test.js` | Graph mutation/persistence behavior | Graph append return/throw boundaries if more direct evidence is required |
| `test/kernel-facade-contract.test.js` | Frozen public Kernel facade and type markers | Future audit method/type parity only after the contract authorizes it |
| `test/kernel-constructor-variant-contract.test.js` | Kernel v1/v2 selection | Future KernelV2 audit delegation only after a runtime seam exists |
| Future `test/kernel-cli-audit-seam-contract.test.js` | None at this base | Bounded intent shape, failure isolation, timing, Kernel v1/v2 delegation, and negative side effects |

No deliberately red test for a missing future method belongs in this gate.

## Observed Gaps

The following are directly observed at the canonical base:

1. Interactive `kaydet`, `exit`, and `cikis` paths bypass `execute()`, the CLI
   mutation gate, and CLI audit handling.
2. Direct `execute('kaydet')` audits an allow decision but does not persist
   because there is no matching switch case.
3. `details.executed` represents gate authorization, not actual completion.
4. Audit is attempted before backup, restore, or other allowed mutation work.
5. A later mutation failure cannot update the already appended event.
6. CLI audit errors are silently swallowed.
7. CLI passes no workspace or provenance context and receives default/empty
   normalized values.
8. CLI receives but ignores no returned event because it does not capture the
   Graph return value.
9. Current CLI events contain no approval, receipt, final result, or error
   linkage.
10. No public Kernel or KernelV2 intent-level audit seam exists.
11. Existing tests prove classifications and event presence more strongly than
    exact event semantics, ordering, or failure isolation.

## Deferred Findings

### Observed and deferred

- Interactive save/exit audit bypass.
- Pre-execution meaning of `executed`.
- Silent CLI audit failure.
- Default workspace and empty provenance fields.
- Lack of approval/receipt/final-outcome linkage.
- Generic Graph mutation compatibility access.
- Absence of Kernel v1/v2 public audit methods and declarations.

### Inferred and deferred

- Repeated gate evaluation can create semantic duplicate events because each
  normalization receives a fresh UUID.
- SQLite-backed and JSON-only deployments have different immediate durability
  characteristics.
- The audit append and the actual mutation cannot provide transactional
  atomicity under the current ordering.

### Unverified and deferred

- Whether external consumers depend on the exact `details.executed` meaning.
- Whether future CLI audit events must carry a non-default workspace.
- Whether an approval or receipt identifier is required.
- Whether silent failure, warning metadata, or a structured non-blocking result
  is the correct future public behavior.

These findings are not fixes authorized by this gate.

## REFACTOR-1C3B Contract Questions

REFACTOR-1C3B must answer, without implementation:

1. What is the exact intent-level Kernel method name and signature?
2. Is the input a bounded CLI mutation intent rather than a generic audit
   event?
3. Which fields are caller-supplied, derived, forbidden, or defaulted?
4. Does the contract model authorization attempt, execution start, completion,
   or more than one phase?
5. Must the current `executed` field be retained, renamed, or explicitly
   deprecated without changing existing records?
6. What is returned on success and on best-effort audit failure?
7. Is failure silent, logged, or represented as bounded non-blocking metadata?
8. How are workspace, provenance, actor, approval, and receipt boundaries
   handled without inventing trust claims?
9. Must KernelV2 delegate exactly to Kernel v1?
10. Which declarations and facade tests become owners of the new method?
11. How will interactive save/exit and direct `execute()` paths converge without
    changing command output or mutation ordering unexpectedly?
12. Which persistence behavior is guaranteed, and which durability/atomicity
    claims remain forbidden?

## Successor Gate Decomposition

The binding sequence is:

```text
REFACTOR-1C3A
  source reality only

REFACTOR-1C3B
  audit event and intent-level Kernel contract

REFACTOR-1C3C
  failure-isolation and baseline contract tests

REFACTOR-1C3D
  intent-level Kernel audit method plus authorized declarations/delegation tests

REFACTOR-1C3E
  CLI callsite migration and exact behavior regression tests

REFACTOR-1C3F
  source-boundary verification and closeout audit
```

Each successor requires a separate exact-base authorization after its
predecessor is reviewed, merged, and closed.

## Allowed Scope

This gate may change exactly:

```text
docs/task-packs/refactor-1c3-cli-audit-seam-source-reality.md
```

It may inspect repository sources and existing tests read-only.

## Forbidden Scope

- `cli.js`
- `kernel.js`
- `kernel.v2.js`
- `graph.js`
- `kernel.d.ts`
- `kernel.v2.d.ts`
- all test files
- audit event schemas or vocabularies
- runtime behavior or command output
- MCP, server, V5, connector, or transport behavior
- package or dependency files
- workflows or Docker files
- Policy Auditor implementation
- approval, receipt, trust, or authorization implementation
- successor gate implementation

## Acceptance Criteria

1. Exactly one docs/task-pack file changes.
2. The CLI call graph and interactive bypasses match current source.
3. The command matrix covers save, backup, restore, optimize, evolve,
   consolidate, auto-think start/stop, dream, and exit aliases.
4. Event fields, normalization defaults, timing, and failure semantics are
   exact.
5. Graph and private Kernel audit contracts are distinguished.
6. KernelV2, declaration, and facade absence are recorded without inventing a
   method.
7. Observed, inferred, and unverified findings are separated.
8. Test ownership and missing evidence are explicit.
9. Successor gates remain independently authorized.
10. `git diff --check` passes and worktree scope is exact.
11. The mandatory `Competitive register rows consulted` field evaluates
    RTG-006, RTG-009, and CE-010, preserves their OPEN status, and does not
    substitute CE-009 for the audit-durability record.

## Stop Conditions

Stop and report rather than broaden scope if:

- canonical source differs from this document's observed call graph;
- a command has contradictory gate and runtime behavior that cannot be stated
  without a product decision;
- a new audit vocabulary or schema is required to finish source reality;
- runtime, test, declaration, or package changes appear necessary;
- canonical base advances before commit or push;
- the one-file scope cannot be preserved;
- validation or existing related tests fail.

Stop verdict:

```text
REFACTOR-1C3A_BLOCKED_SOURCE_CONFLICT
```

## Non-Claims

This task-pack does not claim that:

- all CLI mutations are currently audited;
- `executed: true` means a mutation succeeded;
- audit persistence and mutation are atomic;
- audit events are durable in every persistence mode before `save()`;
- audit events establish trust, authorization, approval, or safe execution;
- Graph internals are the desired public CLI seam;
- `Kernel._appendAuditEvent()` is public or stable;
- KernelV2 already delegates an audit contract;
- the CLI audit seam has been implemented or tested;
- REFACTOR-1C3 or the wider refactor program is complete;
- Policy Auditor is authorized.

## Validation

Docs-only validation:

```bash
node --test \
  cli.test.js \
  graph.test.js \
  test/kernel-facade-contract.test.js \
  test/kernel-constructor-variant-contract.test.js

git diff --check main...HEAD
git diff --name-only main...HEAD
git status --short
```

Expected changed file:

```text
docs/task-packs/refactor-1c3-cli-audit-seam-source-reality.md
```

## Commit and Review Lifecycle

Commit:

```text
docs: define CLI audit seam source reality
```

The commit must include the repository-local identity:

```text
Ali ULU <aliulu@ai-ulu.com>
```

Push the dedicated branch and open a draft PR. Do not merge, enable
auto-merge, or start REFACTOR-1C3B.

Successful handoff verdict:

```text
REFACTOR-1C3A_AUDIT_SOURCE_REALITY_READY_FOR_INDEPENDENT_READ_ONLY_REVIEW
```
