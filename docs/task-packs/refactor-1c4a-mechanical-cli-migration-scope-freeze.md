# REFACTOR-1C4A - Mechanical CLI Migration Scope Freeze

## Purpose

This docs-only gate reconciles the REFACTOR-1C inventory with canonical source
after REFACTOR-1C3 closeout. It freezes the remaining CLI-to-Graph migration
work without repeating migrations already completed by REFACTOR-1C2 and
REFACTOR-1C3.

This gate does not change runtime code, declarations, tests, packages, or
repository configuration.

## Canonical Base

- Repository: `ali-ulu/huqan`
- Required branch: `main`
- Required base: `e87db0777ffef86a8052d5c4f8fe2e5c93fc66e3`
- Previous checkpoint: `REFACTOR-1C3_CLOSEOUT_AUDIT_GREEN`
- Current gate: `REFACTOR-1C4A_MIGRATION_SCOPE_FREEZE`
- Authorized successor after separate review, merge, and closeout:
  `REFACTOR-1C4B_STATUS_READ_MIGRATION`

The base above records the source state used by this scope freeze. Every
successor must start from a separately verified canonical `main` SHA.

## Governing Sources

- `docs/task-packs/refactor-1c-cli-graph-internal-coupling-scope.md`
- `docs/task-packs/refactor-1c2-kernel-lifecycle-maintenance-seam-scope.md`
- `docs/task-packs/refactor-1c3b-cli-audit-event-contract.md`
- `cli.js`
- `kernel.js`
- `kernel.d.ts`
- `kernel.v2.js`
- `kernel.v2.d.ts`
- `cli.test.js`
- `test/kernel-lifecycle-maintenance-seam-contract.test.js`
- `test/kernel-cli-audit-seam-contract.test.js`
- `test/kernel-cli-audit-baseline-contract.test.js`
- HUQAN Master Roadmap v3.1 and v3.2 Competitive Register

Current canonical source wins if an older inventory statement conflicts with
the source at the required base.

## Canonical Source Reality

The original REFACTOR-1C inventory identified these direct runtime accesses:

```text
kernel.graph.memoryPath
kernel.graph.load()
kernel.graph.save()
kernel.graph.optimize()
kernel.graph._nodes
kernel.graph._edges
kernel.graph.appendAuditEvent()
```

At the canonical base their disposition is:

| Inventory item | Canonical CLI path | Disposition |
| --- | --- | --- |
| `kernel.graph.memoryPath` | `_backupOptions()` calls `kernel.getPersistenceDescriptor()` | migrated and contract-tested |
| `kernel.graph.load()` | restore and startup use `kernel.reload()` | migrated and contract-tested |
| `kernel.graph.save()` | interactive save and exit use `kernel.persist()` | migrated and contract-tested |
| `kernel.graph.optimize()` | optimize command uses `kernel.optimize()` | migrated and contract-tested |
| `kernel.graph.appendAuditEvent()` | `_auditCliMutation()` calls `kernel.recordCliMutationAudit()` | migrated and contract-tested |
| `kernel.graph._nodes` | `durum` counts global nodes | open; REFACTOR-1C4B owner |
| `kernel.graph._edges` | `durum` counts global edges | open; REFACTOR-1C4B owner |

No other production `cli.js` access to the inventoried Graph internals exists
at this base. Test-only Graph access remains compatibility and fixture setup;
it is not production callsite scope for REFACTOR-1C4B.

## Reconciled Gate Ownership

The roadmap labels remain stable, but completed work is not reimplemented:

| Gate | Reconciled state | Required action |
| --- | --- | --- |
| REFACTOR-1C4B | open | migrate only `durum` global node/edge reads |
| REFACTOR-1C4C | satisfied by REFACTOR-1C2 closeout | evidence audit only |
| REFACTOR-1C4D | satisfied by REFACTOR-1C2 closeout | evidence audit only |
| REFACTOR-1C4E | satisfied by REFACTOR-1C2 closeout | evidence audit only |
| REFACTOR-1C4F | satisfied by REFACTOR-1C3 closeout | evidence audit only |
| REFACTOR-1C4G | open | enforce zero inventoried direct access in production CLI source |
| REFACTOR-1C4H | open | full regression, release smoke, and closeout |

Evidence audit means verifying canonical source, tests, and merge lineage. It
does not authorize a replacement implementation or a new compatibility layer.

## REFACTOR-1C4B Contract

The `durum` command must stop reading `_nodes` and `_edges` directly. The
replacement must use the existing read-only Graph stats behavior through the
narrowest already-approved compatibility path.

The migration must preserve:

- global node count;
- global edge count;
- exact status wording and ordering;
- entropy formatting;
- gap and contradiction sections;
- workflow-runtime status line;
- synchronous command behavior;
- Kernel v1 and explicit KernelV2 behavior.

It must not expose collections, add a mutable Graph adapter, introduce
workspace filtering, or create a new public API without a separate contract
gate.

## Implementation Scope

REFACTOR-1C4B may change only:

```text
cli.js
cli.test.js
```

If an existing approved seam cannot preserve the exact global-count behavior
within those files, stop with:

```text
REFACTOR-1C4B_BLOCKED_BY_STATUS_READ_SEAM_GAP
```

Do not widen the implementation scope inside that gate.

## Source-Boundary Enforcement

REFACTOR-1C4G owns a permanent source-boundary assertion covering production
`cli.js`. It must reject the complete original inventory:

```text
.graph.memoryPath
.graph.load(
.graph.save(
.graph.optimize(
.graph._nodes
.graph._edges
.graph.appendAuditEvent(
```

The assertion must not ban test fixtures from observing the documented
`kernel.graph` compatibility surface and must not claim that all repository
Graph access has been removed.

## Validation and Closeout

The implementation and closeout chain must include:

1. exact `durum` regression tests for empty and populated global counts;
2. existing CLI lifecycle, audit, facade, and constructor-variant contracts;
3. source-boundary enforcement;
4. full `npm test` with zero failures;
5. Security Checks;
6. Benchmark Regression, including Docker build;
7. clean-clone CLI smoke;
8. exact-head review, merge lineage, diff check, and clean worktree.

Success requires:

```text
REFACTOR-1C4_CLOSEOUT_AUDIT_GREEN
```

## Competitive Register Rows Consulted

- `CE-001`: `ADAPT`; this gate keeps decision/enforcement ownership outside a
  generic Graph adapter. Status remains open for REFACTOR-4.
- `CE-004`: `ADOPT`; visibility, invocation, startup, and mutation coverage
  remain distinct. Status remains open for REFACTOR-4.
- `RTG-002`: `KNOWN_BLOCKER`; this CLI-only migration does not close the
  broader public mutation-entrypoint gap.
- `RTG-006`: `REQUIRED_COVERAGE_AUDIT`; production CLI source-boundary tests
  contribute evidence but do not close the four-surface audit.

No register row is closed or reclassified by this scope document.

## Forbidden Scope

- Graph redesign or changes to `graph.js`;
- new generic Graph adapter or pass-through API;
- public Kernel method, declaration, or constructor-identity changes;
- persistence format or path behavior changes;
- audit event, verdict, receipt, or approval changes;
- MCP, server, REST, V5, Policy Auditor, package, dependency, workflow, or
  Docker changes;
- behavior changes to backup, restore, reload, persist, optimize, or audit;
- broad cleanup of test-only Graph compatibility access.

## Stop Conditions

Stop instead of inventing behavior if:

- global count semantics differ between the current source and proposed read
  path;
- exact output cannot be preserved;
- a new Kernel or Graph API is required;
- implementation needs a file outside the REFACTOR-1C4B scope;
- any previously migrated lifecycle or audit behavior must change;
- targeted, full-suite, security, benchmark, or Docker validation fails for a
  source-related reason.

## Non-Claims

This gate does not claim that:

- REFACTOR-1C4 implementation is complete;
- all repository Graph access is removed;
- `kernel.graph` compatibility is removed;
- Graph, Memory, or Persistence decomposition is complete;
- surface parity or mutation-entrypoint coverage is complete;
- Policy Auditor or any post-refactor program is authorized.
