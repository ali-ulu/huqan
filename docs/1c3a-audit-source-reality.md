# 1C3A Audit Source Reality

## Decision and boundary

```text
1C3A_AUDIT_SOURCE_REALITY: DOCS_ONLY_SOURCE_MAP
```

This document records the live source reality of the CLI mutation-audit seam. It
is an audit and source map, not a runtime implementation, test rewrite, Graphify
replacement, or product-maturity claim.

The scope is intentionally limited to:

- the CLI command classification and mutation gate;
- the Kernel audit seam used by CLI code;
- the durable audit writer and Graph normalization boundary;
- the attempted/committed event ordering and failure behavior; and
- the current test ownership and verification limits.

The following are explicitly out of scope for this gate:

- changing CLI behavior;
- changing audit event fields or event semantics;
- adding a new audit subsystem;
- migrating commands to MCP or changing command-to-tool mappings;
- regenerating or inventing Graphify output;
- claiming that the full test suite is green; and
- declaring 1C3B, 1C3C, 1C3D, or 1C3E complete.

## Evidence envelope

```text
[BAĞLAM]
repository: ali-ulu/huqan
base: live origin/main
working branch: docs/1c3a-audit-source-reality
exact source: 0e70c66fb4a653f963fd297879ac6ce42c95b48d
package: 0.9.1

[GÖREV]
Document the live CLI audit source reality without changing runtime behavior.

[KABUL]
The document identifies the real call graph, command matrix, event shape,
failure boundary, test owner, exact source identity, and verification limits.

[YASAK]
No runtime code, test code, dependency, Graphify artifact, or unrelated document
may be changed in this gate.

[SÜRÜM]
docs/1c3a-audit-source-reality.md; source SHA above; document SHA is reported
with the delivery evidence after the file is written.
```

The exact live `origin/main` source outranks older roadmap and checkpoint prose.
The mutable checkpoint records `0fef5948...` and the roadmap records
`0a1cc370...`, while the live checkout used for this audit is
`0e70c66fb4a653f963fd297879ac6ce42c95b48d`. Those older identities are not used
as the implementation base for this document.

## Source authority and artifact status

| Artifact | Observation | Evidence class |
|---|---|---|
| `origin/main` and current branch | Both point to `0e70c66fb4a653f963fd297879ac6ce42c95b48d` at audit start | GÖZLENDİ |
| Working tree | Clean before the docs-only change | GÖZLENDİ |
| `graphify-out/` | No Graphify report or wiki index was available in this checkout | GÖZLENDİ |
| Live JavaScript source | Used as the controlling source map | GÖZLENDİ |
| Historical roadmap/checkpoint identities | Older than the live source | GÖZLENDİ |
| Full runtime/test status at this snapshot | Not re-established by this docs-only audit | DOĞRULANMADI |

Because Graphify output is absent, this document deliberately uses live source and
existing contract tests as the fallback evidence path. It does not manufacture an
AST graph, a source graph image, or a graph-derived completion claim.

## Canonical source map

### 1. CLI classification and gate

`lib/cli-mutation-gate.js` owns the synthetic gate for CLI commands that do not
have a `huqan.*` MCP tool but can still mutate local or canonical state.

The gate classifies a command, writes an attempted audit event for every audited
mutation, and returns an execution decision. A missing or failed audit sink blocks
the command instead of allowing an unaudited mutation.

| Command / input | Decision | Mutation type | Event type | Execution eligible | Reason | Audit behavior |
|---|---|---|---|---:|---|---|
| `kaydet` | `allow` | `persistence` | `UPDATE` | yes | `cli_persist_local` | attempted, then committed |
| `backup` | `allow` | `export` | `EXPORTED` | yes | `cli_backup_export_local` | attempted, then committed |
| `restore` | `allow` | `state_replace` | `IMPORTED` | yes | `cli_restore_state_replace_local` | attempted, then committed after reload |
| `quickstart` | `allow` | `demo_sandbox` | `UPDATE` | yes | `cli_quickstart_isolated_demo_store` | audited isolated demo flow |
| `evolve` | `review` | `canonical` | `REVIEW` | no | `cli_canonical_mutation_requires_review` | attempted; execution is withheld |
| `optimize` | `review` | `canonical` | `REVIEW` | no | `cli_canonical_mutation_requires_review` | attempted; execution is withheld |
| `konsolide` | `review` | `canonical` | `REVIEW` | no | `cli_canonical_mutation_requires_review` | attempted; execution is withheld |
| `düşün` / `dusun` | `review` | `automation` | `REVIEW` | no | `cli_automation_requires_review` | attempted; execution is withheld |
| `düşün dur` / `düşünmeyi durdur` | control | `none` | none | yes | `cli_automation_stop` | intentionally unaudited control path |
| `ruya` | `allow` | `none` | none | yes | `cli_read_only_inference` | no mutation audit |
| `durum`, `sor`, `selam`, `yardım` and other unknown/read-only commands | no synthetic gate | `none` | none | normal command path | not a classified mutation | no mutation audit |

The table is a source map, not a new contract. The values above are observed in
`CLI_MUTATION_GATE` and `classify()`; they must not be changed by this gate.

### 2. CLI callsites

`cli.js` delegates the relevant work instead of owning a second audit writer:

```text
CLI command parsing
  -> mapCliCommandToMcpTool(command)
  -> if no MCP tool: _evaluateCliMutationGate(command, args)
  -> lib/cli-mutation-gate.js::evaluateCliMutationGate()
  -> _auditCliMutation()
  -> lib/cli-mutation-audit.js::auditCliMutation()
  -> Kernel.recordCliMutationAudit(intent)
```

For commands that actually execute, the command path emits the committed event
through `_commitCliMutation()` after the state operation:

```text
attempted audit
  -> local operation / persistence / reload
  -> committed audit
```

Observed one-shot callsites include `backup`, `kaydet`, and `restore`. The
interactive `kaydet` and exit/save path use the same attempted-before-persist
ordering. The CLI source does not call `this.kernel.graph.appendAuditEvent`
directly; the direct Graph boundary is below the Kernel seam.

### 3. Kernel seam

`kernel.js` exposes:

```js
recordCliMutationAudit(intent) {
  return recordCliMutationAudit(this.graph, intent);
}
```

`kernel.v2.js` delegates the same method to the wrapped Kernel instance:

```js
recordCliMutationAudit(intent) {
  return this.kernel.recordCliMutationAudit(intent);
}
```

This preserves one durable writer and keeps the CLI dependent on a Kernel seam,
not on Graph internals.

### 4. Durable writer and Graph boundary

`lib/cli-mutation-audit.js` is the durable half of the seam. It:

1. validates the bounded intent with `validateCliMutationAuditIntent()`;
2. refuses a missing Kernel/Graph audit writer;
3. constructs the canonical CLI details object;
4. calls `graph.appendAuditEvent()` with `targetType: 'cli_mutation'`;
5. rejects a non-object or Promise-like result as non-durable; and
6. returns `{ auditRecorded: false, errorCode: 'AUDIT_WRITE_FAILED' }` on failure
   rather than throwing into the CLI process.

The details object contains:

```text
source, command, mutationType, decision, executed, reason, phase
```

`approvalState` and `receiptId` are added only when present in the validated
intent. The event actor defaults to `cli-user` and the workspace defaults to
`default` at this boundary.

`graph.js` owns `appendAuditEvent()`, which normalizes through
`buildAuditEvent()` from `lib/audit-log.js` and then appends the result to the
in-memory event list and, when a database is attached, the SQLite insert
statement. `lib/audit-log.js` is therefore the canonical normalizer, not
`graph.js`; the sibling `normalizeAuditEvent()` from the same module is used on
the load/rehydrate paths rather than on append.

Normalization adds or resolves the canonical `auditId`, `eventType`,
`targetType`, `targetId`, `workspaceId`, `actor`, `timestamp`, `sourceRef`,
`provenanceId`, `trustPolicyVersion`, and JSON-safe `details`. The CLI writer
therefore does not reimplement audit normalization.

### 5. Failure boundary

The source has two distinct failure boundaries:

| Boundary | Source behavior | Classification |
|---|---|---|
| Audit fails before a mutation runs | `evaluateCliMutationGate()` returns `decision: 'block'`, `canExecute: false`; command does not persist or mutate | GÖZLENDİ / fail-closed admission |
| Committed audit fails after a mutation ran | `_commitCliMutation()` returns a warning string; the already-completed state change is not rolled back | GÖZLENDİ / post-mutation evidence warning |

Therefore the precise claim is **fail-closed admission for audited mutations**.
It is not correct to claim transactional rollback of a mutation when its
post-mutation committed audit record cannot be written.

## Current test ownership

The existing source-backed owner is:

```text
test/kernel-cli-audit-baseline-contract.test.js
```

The file currently labels its suite `REFACTOR-1C3E: CLI audit callsite migration
contracts`. It covers, among other cases:

- no direct Graph audit access from CLI source;
- one Kernel seam call per mutation gate mapping;
- bounded intent and Graph-side normalization;
- missing and throwing audit sinks blocking mutations;
- read-only commands remaining usable when the sink is unavailable;
- review-gated commands not invoking the mutation;
- attempted/committed ordering for `kaydet`, `backup`, and `restore`;
- interactive save and exit behavior; and
- KernelV2 seam delegation with one underlying Graph append.

This is useful evidence for the source map, but the test filename and suite label
must not be silently relabeled as proof that later roadmap gates are complete.
Gate completion needs its own acceptance evidence and exact CI identity.

## Acceptance and verification record

### GÖZLENDİ

- The working branch was created from the live `origin/main` snapshot.
- The source snapshot is `0e70c66fb4a653f963fd297879ac6ce42c95b48d`.
- The package version is `0.9.1`.
- The CLI delegates the mutation audit through the Kernel seam.
- `lib/cli-mutation-audit.js` is the single durable CLI audit writer.
- `graph.js` is the append boundary; `lib/audit-log.js` is the canonical event
  normalizer it appends through.
- Existing tests cover the mapped source seams and failure behaviors.
- `git diff --check` is the acceptance check for this docs-only change and must
  pass before commit.

### TÜRETİLDİ

- The live call graph has one intended CLI-to-Graph audit seam rather than a
  second CLI-owned Graph writer.
- The current source supports a narrow, auditable mutation boundary; it does not
  support a claim that every CLI command is a mutation or that every command is
  audited.
- The correct next implementation question is event/contract and failure
  isolation evidence, not a new audit subsystem.

### DOĞRULANMADI

- A fresh full `npm test` green result at this source snapshot.
- A fresh targeted runtime test green result in this checkout.
- Graphify report/wiki regeneration or AST graph evidence.
- GitHub Actions results for this new docs-only branch.
- External consumer interoperability or any V5 implementation-entry claim.

A targeted run of
`node --test test/kernel-cli-audit-baseline-contract.test.js` was attempted. The
first source assertion (`removes direct Graph audit access from CLI source`)
passed, but the runtime cases could not initialize because `better-sqlite3` is
not installed in the local checkout. The observed error was
`HUQAN_SQLITE_UNAVAILABLE` / `MODULE_NOT_FOUND`. No dependency installation or
runtime workaround is part of this docs-only gate.

## Two-minute user eye test

From the repository root:

```bash
sed -n '1,260p' docs/1c3a-audit-source-reality.md
git diff --check
```

Expected result: the document shows the exact source SHA, command matrix, CLI to
Kernel to Graph call graph, failure boundary, test owner, and explicit
`DOĞRULANMADI` list; `git diff --check` prints no error.

For source spot-checking:

```bash
rg -n 'CLI_MUTATION_GATE|recordCliMutationAudit|appendAuditEvent|commitCliMutation' \
  lib/cli-mutation-gate.js lib/cli-mutation-audit.js kernel.js kernel.v2.js cli.js
```

If the command matrix differs from the live source, the first place to inspect
is the exact source SHA in the audit snapshot, not a historical roadmap.

## Next-agent envelope

```text
[BAĞLAM]
1C3A docs-only source map prepared from live origin/main
at 0e70c66fb4a653f963fd297879ac6ce42c95b48d.

[GÖREV]
Review this source map and decide whether 1C3B should lock the observed event
shape/order as an explicit contract, without changing runtime behavior in the
review-only step.

[KABUL]
Use a fresh exact-head source check, add only the minimum approved contract
coverage, and report test/CI/worktree evidence with GÖZLENDİ/TÜRETİLDİ/
DOĞRULANMADI labels.

[YASAK]
Do not rename audit fields, change gate decisions, bypass the Kernel seam,
regenerate absent Graphify artifacts, or infer external interoperability.

[SÜRÜM]
Base source: 0e70c66fb4a653f963fd297879ac6ce42c95b48d
Artifact: docs/1c3a-audit-source-reality.md
```

## Source references

- `lib/cli-mutation-gate.js`: command classification, admission decision,
  attempted audit, and committed audit.
- `lib/cli-mutation-audit.js`: bounded intent validation and durable writer.
- `kernel.js`: KernelV1 `recordCliMutationAudit()` seam.
- `kernel.v2.js`: KernelV2 delegation seam.
- `graph.js`: audit append boundary and durable persistence.
- `lib/audit-log.js`: canonical audit event normalization (`buildAuditEvent()`
  on append, `normalizeAuditEvent()` on rehydrate).
- `cli.js`: command routing and operation ordering.
- `test/kernel-cli-audit-baseline-contract.test.js`: current contract test owner.
- `docs/agent-canon.md`: source authority, change discipline, and evidence rules.
- `docs/current-operating-roadmap.md`: current gate ordering and non-claims.

This document intentionally records what the live source supports and what it
does not yet prove. It does not promote an observed seam into a broader product
claim.
