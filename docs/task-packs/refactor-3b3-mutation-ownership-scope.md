# REFACTOR-3B3 - Graph Mutation Ownership Scope

## Gate

- Repository: `ali-ulu/huqan`
- Canonical base: `main @ 220c73766ede2c1f0a15a36017da0fc46d0a6795`
- Previous checkpoint: `REFACTOR-3B2C_READ_BOUNDARY_CLOSEOUT_GREEN`
- Mode: source-reality and task-pack only

This gate separates the three remaining direct Graph mutation owners before
runtime code changes. It does not authorize a Graph method, caller migration,
test change, declaration change, or persistence behavior change.

## YAGNI Decision

Do not add a generic collection setter, mutable collection alias, mutation
callback, repository, facade, adapter, transaction abstraction, or dependency.
The three mutation paths have different ordering, identity, workspace,
persistence, hook, and error contracts.

Use this order for every successor:

1. remove work that does not need to exist;
2. reuse an exact existing Graph method;
3. use the Node.js standard library or a native platform feature;
4. reuse an installed dependency;
5. prefer the smallest behavior-preserving expression;
6. add one intent-level Graph operation only when executable evidence proves
   that no existing method is exact.

## Source Reality

### 1. Dream embedding mutation

Owner: `dream.js`.

Current behavior:

- `embedding()` emits `beforeEmbedding` before inspecting the Graph;
- option defaults use the current truthy `||` semantics;
- node iteration uses global Graph storage-key insertion order;
- fewer than two nodes returns `null` and does not emit `afterEmbedding`;
- each successful node receives a fresh `Float64Array` with the requested
  dimensions;
- assignment replaces the node's previous `embedding` reference in place;
- projection, normalization, walk ordering, and return shape remain owned by
  Dream;
- the method does not call `getNode()`, create access touches, save the Graph,
  or write the embedding sidecar directly;
- an event or computation failure has no rollback contract, and an
  `afterEmbedding` failure can occur after embeddings were assigned;
- Graph save/load separately strips, writes, and restores embeddings.

Existing tests cover empty and single-node results, vector presence and
dimensions, similarity, and non-identical vectors for symmetric nodes. They do
not yet lock hook ordering, replacement identity, global workspace/storage-key
behavior, no-touch behavior, or no-save behavior.

Required ownership direction:

- keep embedding computation and scoring in Dream;
- if a new operation is proven necessary, it may only assign one already
  computed embedding to one exact existing storage identity;
- do not expose the live node map or move embedding computation into Graph;
- do not change sidecar persistence in this chain.

### 2. KernelV2 temporal edge metadata mutation

Owner: `kernel.v2.js`.

Current behavior:

- `learn()` snapshots pre-learn edge keys as
  `from|relation|to`, intentionally omitting workspace identity;
- it delegates synchronously to Kernel v1 `learn()` before applying metadata;
- after delegation it scans every live edge, including pre-existing edges;
- a newly observed edge receives `createdAt` only when that field is absent;
- every edge receives `updatedAt`;
- a falsey `opts.source` is normalized to `user` before mutation, so it writes
  `source: user` and may append `source:user` evidence;
- a truthy source replaces `source` and appends one deduplicated
  `source:<source>` evidence item;
- a non-array evidence value is replaced with an empty array;
- review-only learns that add no edge still update existing edges;
- metadata is applied after Kernel v1's learn/save path and is therefore not
  granted a new immediate durability claim by this refactor;
- JSON and SQLite currently have different persistence details for the added
  camel-case metadata, and this gate does not align those backends;
- a Kernel v1 learn error prevents the metadata phase, while a metadata-phase
  error propagates without rollback;
- current workspace-blind edge-key collision behavior is preserved.

Existing tests cover a new edge and the review-only existing-edge side effect.
They do not yet lock all-edge ordering, `createdAt` preservation, falsey source,
non-array evidence replacement, exact evidence deduplication, cross-workspace
key collision behavior, or absence of an extra save.

Required ownership direction:

- KernelV2 keeps orchestration, before-edge capture, and result-envelope
  ownership;
- any Graph operation must express only the existing temporal metadata intent;
- do not fix workspace collisions, add transactions, or change durability in
  this chain;
- do not move Kernel v1 learning or admission behavior into Graph.

### 3. Kernel consolidation mutation

Owner: `kernel.js`.

Current behavior:

- `consolidate(dryRun = true)` scans the live edge array in insertion order;
- edges with `kistlama` are excluded from both removal phases;
- phase one groups by `from|to` and marks edges below `0.3` only when a peer
  for that pair has weight at least `0.5`;
- phase two groups unmarked edges by `from|relation` and applies the same
  thresholds;
- both grouping keys omit workspace identity, so equal IDs in different
  workspaces currently participate in the same global decision;
- removal details preserve discovery order and current wording;
- dry-run returns the same result without replacing edges, rebuilding indexes,
  or saving;
- a non-dry run with removals replaces the edge array while preserving retained
  edge object identities and order, rebuilds indexes once, and attempts one
  save;
- save errors are logged and swallowed; the already-applied in-memory mutation
  and return result are preserved;
- `selfEvolve()` can perform a later additional save outside `consolidate()`;
- a non-dry run with no removals does not rebuild or save.

There is no focused executable consolidation contract today. Runtime migration
is blocked until a green baseline locks selection, ordering, identity, index,
save, and error behavior.

Required ownership direction:

- Kernel keeps the public `consolidate()` facade and result contract;
- the selection and mutation may move only as one intent-level maintenance
  operation after the baseline is green;
- do not add an edge-array setter, expose mutable edges, or silently make save
  failure transactional;
- do not combine consolidation with Graph `optimize()`.

## Behavior That Must Not Be Collapsed

- Node embedding assignment is not edge metadata mutation.
- Temporal metadata is not provenance, admission, or persistence ownership.
- Consolidation is not generic edge filtering or `optimize()`.
- A global storage-key scan is not a default-workspace operation.
- An in-memory post-learn metadata update is not an immediate durability claim.
- Preserving a known workspace-blind key is not approving it as correct product
  behavior.
- Best-effort save is not transactional rollback.

## Test Ownership

- `dream.test.js`: Dream hook, global ordering, vector identity/type,
  no-touch, no-save, failure/rollback, and existing result behavior;
- `test/refactor-2e-learn-memory-admission-contract.test.js`: KernelV2 new-edge
  and review-only temporal compatibility;
- one focused temporal test file only if the existing owner would mix unrelated
  admission scenarios;
- `kernel.test.js`: public consolidation result and facade behavior;
- one focused consolidation contract file only if ordering, index, and save
  failure cannot be expressed clearly in `kernel.test.js`;
- `graph.test.js`: only Graph-owned intent-level operations after their caller
  baselines are green.

No deliberately red seam-existence test is allowed. Baseline tests must pass on
the canonical source before runtime migration.

## Successor Sequence

1. `REFACTOR-3B3A_MUTATION_BASELINE_CONTRACT_TESTS`
   - add only missing green current-source assertions for all three owners;
   - change no runtime or declaration file.
2. `REFACTOR-3B3B_DREAM_EMBEDDING_OWNERSHIP`
   - migrate only the proven embedding assignment boundary;
   - keep Dream computation, hooks, ordering, and output unchanged.
3. `REFACTOR-3B3C_TEMPORAL_METADATA_OWNERSHIP`
   - migrate only the proven temporal edge-metadata intent;
   - preserve the workspace-blind key and post-learn durability behavior.
4. `REFACTOR-3B3D_CONSOLIDATION_OWNERSHIP`
   - migrate the proven consolidation maintenance intent;
   - preserve dry-run, ordering, retained identity, index rebuild, save, and
     swallowed-error behavior.
5. `REFACTOR-3B3E_MUTATION_BOUNDARY_CLOSEOUT`
   - require no unauthorized direct mutation assigned to this chain;
   - retain no generic collection mutation escape hatch.

Each implementation owner remains independently reviewable and requires an
exact canonical base, narrow file scope, targeted and full tests, independent
read-only review, Security Checks, Benchmark Regression, Docker build,
exact-head merge, post-merge smoke, and closeout.

## Allowed Output

Only this task-pack document may change in REFACTOR-3B3.

## Forbidden Scope

- changes to `graph.js`, `dream.js`, `kernel.js`, `kernel.v2.js`, tests,
  declarations, schemas, package files, workflows, or Docker;
- generic snapshots, repositories, facades, adapters, setters, callbacks,
  transactions, iterators, or mutable collection aliases;
- changing public Kernel, KernelV2, Graph, verdict, receipt, or envelope shape;
- changing workspace defaults, storage keys, ordering, identity, thresholds,
  access touches, SQLite, JSON, sidecar, load/save, or error behavior;
- fixing temporal workspace collisions or making metadata immediately durable;
- changing Dream randomness, projection, scoring, or persistence;
- combining consolidation with optimize or adding rollback semantics;
- server, plugin, demo, script, V5, Policy Auditor, product, or dependency work.

## Stop Conditions

Stop and report `REFACTOR-3B3_BLOCKED_BY_MUTATION_CONTRACT_CONFLICT` if:

- a green baseline cannot express current ordering, identity, persistence, or
  error behavior;
- a proposed operation needs a live mutable collection alias;
- a migration changes workspace identity or temporal collision behavior;
- a migration adds a save, transaction, rollback, touch, or sidecar write;
- consolidation result wording or removal order would change;
- one operation combines Dream, temporal, and consolidation ownership;
- a new public API, schema, dependency, version, verdict, receipt, envelope, or
  product decision is required.

## Acceptance

- this document is the only changed file;
- the three mutation owners are separate and source-accurate;
- current missing baseline evidence is explicit;
- no implementation or seam name is falsely claimed as complete;
- successor gates remain independently authorized and reviewable;
- related and full suites have zero failures;
- Security Checks, Benchmark Regression, and Docker build pass;
- independent review confirms source and roadmap consistency.

## Non-Claims

- no Graph mutation seam was implemented;
- no caller was migrated;
- no workspace collision, durability, transaction, rollback, or persistence
  behavior was fixed;
- Dream, KernelV2, Kernel, Graph, and persistence were not decomposed;
- REFACTOR-3B, REFACTOR-3, and REFACTOR-4 are not complete;
- Policy Auditor has not started;
- the refactor program is not complete.
