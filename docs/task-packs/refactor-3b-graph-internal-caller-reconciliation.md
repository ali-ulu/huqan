# REFACTOR-3B - Graph Internal Caller Reconciliation

## Gate

- Repository: `ali-ulu/huqan`
- Canonical base: `main @ 1fff126c9e0be97d48ca01e40640866f024aa5cf`
- Previous checkpoint: `REFACTOR-3A_CLOSEOUT_AUDIT_GREEN`
- Mode: source-reality and caller-reconciliation planning only

This gate classifies every active direct Graph-collection caller before any
runtime migration. It does not authorize a Graph API, runtime, test, schema,
or persistence change.

## Reuse-First Decision

Apply the following order to every caller:

1. remove work that does not need to exist;
2. reuse an exact existing method;
3. use the Node.js standard library or a native platform feature;
4. reuse an installed dependency;
5. prefer the smallest behavior-preserving expression;
6. introduce a new seam only after source and contract evidence prove that no
   existing method is equivalent.

Do not add a generic Graph snapshot, repository, facade, adapter, mutable
collection alias, or dependency. Similar syntax is not evidence of equivalent
workspace, identity, ordering, access-touch, or persistence behavior.

## Existing Read Contracts

| Method | Current contract | Reconciliation limit |
| --- | --- | --- |
| `nodeCount()` | Global count when no workspace is supplied | Exact replacement for global `Object.keys(_nodes).length` only |
| `edgeCount()` | Global count when no workspace is supplied | Exact replacement for global `_edges.length` only |
| `getNodes(workspaceId)` | Workspace-filtered defensive node records | Not equivalent to an all-workspace `_nodes` scan |
| `getNode(id, workspaceId)` | Defensive record, but updates `lastAccessed` and may persist a SQLite touch | Not a pure replacement for direct existence or label reads |
| `getEdges(nodeId, workspaceId)` | Workspace-filtered defensive outgoing edges | Not an all-edge snapshot |
| `getInEdges(nodeId, workspaceId)` | Workspace-filtered defensive incoming edges | Not an all-edge snapshot |
| `getCandidateClaims(filters)` | Filtered candidate array with current reference behavior | Must not silently gain a defensive-copy or new cross-workspace contract |

## Caller Inventory

| Caller | Current internal access | Class | Observable contract | Exact existing replacement | Required disposition |
| --- | --- | --- | --- | --- | --- |
| `kernel.js` auto-think log | global `_nodes` key count | Read | Global count and existing log text | `nodeCount()` | Mechanical reuse after a focused regression assertion |
| `kernel.js` `selfLearn()` | `_edges.length` before and after | Read | Global edge-count delta | `edgeCount()` | Mechanical reuse; preserve return shape and no new writes |
| `kernel.js` `consolidate()` | scans `_edges`, replaces the array, rebuilds indexes, saves | Mutation | Ordering, duplicate selection, dry-run output, index rebuild, and save/error behavior | None | Dedicated maintenance ownership contract; do not expose mutable edges |
| `kernel.v2.js` temporal metadata | scans and mutates all live `_edges` | Mutation | Edge identity, insertion order, timestamp/source/evidence mutation, v1 delegation, and the current workspace-blind edge key | None | Dedicated temporal-metadata ownership contract; do not silently fix cross-workspace key collisions |
| `dream.js` | all-node scans, embedding reads, and in-place embedding writes | Mixed | Global node order, embedding identity/type, random-walk inputs, and no access-touch | None | Dedicated Dream/embedding ownership contract |
| `causalSimulator.js` | direct node existence and label reads | Pure read | No `lastAccessed` mutation or SQLite touch | None | Preserve as-is until a no-touch lookup contract is separately approved |
| `lib/provenance-query.js` | all nodes, edges, and cross-workspace candidates | Read | Cross-workspace visibility, sort order, public projection, and target lookup | `getCandidateClaims()` is exact for the unfiltered candidate source; no single equivalent exists for nodes or edges | Reuse the candidate method mechanically; define query-specific bounded node/edge reads without widening default getters |
| `server.js` graph view | workspace-filtered scans of all edges | Read | Workspace graph payload, top-node selection, confidence/evidence projection | No all-edge workspace method | Server graph-view contract; no generic snapshot API |
| fact-extraction plugins | passes `_nodes` object into `extractFacts()` | Read | Existing object shape and all-workspace visibility | `getNodes()` is not proven equivalent | Shared fact-extraction input contract before migration |
| `company-brain.js` entity scan | all-node object values filtered by the caller's normalized workspace | Read | `queryCompanyBrain()` always passes an explicit workspace or normalized `default`; insertion order is preserved inside that scope | `getNodes(workspaceId)` is equivalent for the active ranking path | Reuse the existing method mechanically after default/explicit workspace parity is locked; no all-workspace ranking contract exists |
| demos and seed scripts | global reads and labels | Operational read | Demo output and seed reporting | Counts may reuse `nodeCount()`/`edgeCount()`; labels have no pure equivalent | Keep out of runtime migrations unless separately verified |

The fact-extraction plugin set is:

- `plugins/contradiction-alert.js`;
- `plugins/devil-advocate.js`;
- `plugins/discovery-engine.js`;
- `plugins/idea-mri.js`;
- `plugins/company-brain.js`.

Operational callers are `demo-causal-autolearn.js`, `egitim.js`, and
`scripts/seed-demo.js`.

## Behavior That Must Not Be Collapsed

- A global collection scan is not a default-workspace query.
- A no-touch node read is not `getNode()`.
- A defensive record is not a live mutable edge or node.
- A node-specific edge query is not an ordered all-edge scan.
- Cross-workspace provenance access is not a widened default getter.
- Dream embedding writes and KernelV2 temporal writes are different mutation
  owners and must not share a generic mutation callback.
- KernelV2's current temporal edge key omits workspace identity. Any collision
  correction is a separate behavior decision, not a mechanical internal-access
  migration.
- Consolidation is an intent-level maintenance operation, not an edge-array
  setter.

## Minimal Successor Sequence

1. `REFACTOR-3B1_EXACT_EXISTING_METHOD_MIGRATIONS`
   - migrate only global node/edge counts whose existing method is exact;
   - cover Kernel auto-think and `selfLearn()` first;
   - include operational count callers only if their tests and output contract
     are already available;
   - add no new Graph method.
2. `REFACTOR-3B2_BOUNDED_READ_CONTRACTS`
   - lock causal no-touch reads, provenance cross-workspace queries, server
   graph-view projection, and plugin fact-extraction inputs;
   - replace cross-workspace direct candidate-array reads with the existing
     unfiltered `getCandidateClaims()` only after reference/order parity is
     locked;
   - decide each seam independently from executable behavior;
   - do not implement a broad snapshot or expose collections.
3. `REFACTOR-3B3_MUTATION_OWNERSHIP`
   - separate Dream embedding, KernelV2 temporal metadata, and Kernel
     consolidation contracts;
   - prefer intent-level Graph operations only where tests prove exact
     ordering, identity, persistence, and error behavior;
   - do not combine these mutations into one API.
4. `REFACTOR-3B4_DIRECT_CALLER_CLOSEOUT`
   - scan production, plugin, server, demo, and script callers;
   - require zero unauthorized direct collection access;
   - record any deliberately retained compatibility access with a named owner
     and non-blocking backlog gate.

Each successor needs an exact canonical base, narrow allowed files, executable
contract evidence, independent review, CI, exact-head merge, and closeout.
Where no exact behavior-preserving migration exists, retaining the current
caller and recording the conflict is preferable to inventing an abstraction.

## Test Ownership

- `graph.test.js`: Graph workspace, defensive-copy, counting, mutation,
  persistence, and maintenance behavior;
- `kernel.test.js` and `test/kernel-lifecycle-maintenance-seam-contract.test.js`:
  Kernel maintenance and public result behavior; any uncovered auto-think,
  self-learn, or consolidation result needs a focused green baseline before
  migration;
- `test/refactor-2e-learn-memory-admission-contract.test.js`: KernelV2 temporal
  metadata compatibility;
- `dream.test.js`: embedding, similarity, hypothesis, and answer ordering;
- `causalSimulator.test.js`, `graph.causal.test.js`, and focused causal tests:
  missing-node, label, path, and no unintended write behavior;
- `lib/provenance-query.test.js`, `provenance.test.js`, and
  `test/provenance-receipt-bridge.integration.test.js`: cross-workspace
  filtering, ordering, candidate, audit, and canonical-record projection;
- `server.test.js`: workspace graph-data payload and graph view;
- plugin-owned tests where present; the five fact-extraction plugins currently
  lack one shared executable input-shape contract, so a green baseline is
  required before their caller migration;
- `test/cli-graph-source-boundary.test.js`: completed CLI boundary remains
  regression evidence and is not reopened.

If an identified contract lacks an executable owner, the next gate must add a
focused baseline test before runtime code changes. A deliberately red test is
not allowed.

## Allowed Output

Only this task-pack document may change in REFACTOR-3B.

## Forbidden Scope

- changes to `graph.js`, `kernel.js`, `kernel.v2.js`, `dream.js`,
  `causalSimulator.js`, server, plugins, demos, scripts, tests, or declarations;
- new public Kernel, KernelV2, Graph, MemoryStore, server, or plugin API;
- generic snapshots, repositories, facades, adapters, iterators, callbacks, or
  mutable collection aliases;
- changing workspace defaults, ordering, object identity, defensive-copy,
  access-touch, SQLite, JSON, sidecar, load/save, or error behavior;
- schema, package, dependency, workflow, Docker, V5, Policy Auditor, or product
  work;
- removing startup duplicate-load behavior or implementing
  `PERSISTENCE-PATH-ALIGNMENT`.

## Stop Conditions

Stop and open a separately reviewed contract decision if:

- a proposed getter introduces `lastAccessed`, SQLite, persistence, ordering,
  identity, or workspace effects absent from the current caller;
- a caller needs live mutable collection identity;
- a new public API, schema, dependency, version, receipt, verdict, envelope, or
  product behavior decision is required;
- one migration combines unrelated Dream, temporal, consolidation,
  provenance, server, or plugin responsibilities;
- a change can lose Graph data or alter backend/load/save behavior;
- no green baseline test can express the current behavior.

Stop verdict:

`REFACTOR-3B_BLOCKED_BY_CALLER_CONTRACT_CONFLICT`

## Acceptance

- this document is the only changed file;
- every active direct caller is classified by read/mutation and observable
  behavior;
- existing exact methods are reused before any new seam is considered;
- no broad Graph API or mutable collection exposure is proposed;
- related Graph, Kernel, Dream, causal, provenance, server, plugin, and full
  suites have zero failures;
- Security Checks, Benchmark Regression, and Docker build pass;
- independent review confirms source and roadmap consistency.

## Non-Claims

- no direct Graph internal caller was migrated;
- no new Graph read or mutation seam exists;
- Graph, MemoryStore, persistence, Dream, provenance, server, or plugins were
  not decomposed;
- no public API or behavior changed;
- REFACTOR-3 and REFACTOR-4 are not complete;
- Policy Auditor has not started;
- the refactor program is not complete.
