# REFACTOR-3B2 - Bounded Graph Read Contracts

## Gate

- Repository: `ali-ulu/huqan`
- Canonical base: `main @ c79e535ba05bbe00514a00441dfaa88a4c7d47f3`
- Previous checkpoint: `REFACTOR-3B1_CLOSEOUT_AUDIT_GREEN`
- Mode: contract-test scope only

This gate defines executable current-source baselines for the remaining
production, server, provenance, and plugin read-only Graph-internal callers.
Operational demo and seed callers are explicitly deferred to REFACTOR-3B4. It
does not authorize runtime, declaration, or caller migration.

## YAGNI Decision

Do not create one all-node/all-edge snapshot, repository, facade, iterator,
callback, or mutable collection alias. The remaining callers have different
workspace, ordering, identity, projection, and access-touch contracts.

Reuse these existing methods where they are already exact:

- `getCandidateClaims()` for unfiltered cross-workspace candidate iteration;
- `getNodes(workspaceId)` for company-brain ranking because its only active
  caller always supplies an explicit or normalized `default` workspace;
- existing scoped `getEdges()` and `getInEdges()` where a caller needs only
  node-specific edges.

No new test should duplicate an already exact assertion.

## Baseline Clusters

### 1. Causal no-touch node reads

Owner: `causalSimulator.test.js`.

Lock current behavior for:

- missing-node result;
- terminal-node label projection;
- default-workspace node lookup;
- unchanged `lastAccessed` after simulation;
- no SQLite touch/write caused only by node existence or label reads;
- deterministic result ordering and existing error/result shape.

The baseline may inspect source state before and after the call. It must not
call `getNode()` to obtain its own comparison value because that method itself
touches the node.

### 2. Provenance and candidate query reads

Owners:

- `lib/provenance-query.test.js`;
- `test/provenance-receipt-bridge.integration.test.js` only where integration
  evidence is required.

Lock current behavior for:

- scoped and `crossWorkspace: true` node, edge, and candidate visibility;
- current record sort and tie-break order;
- target lookup when an ID matches an edge endpoint or composite edge ID;
- unfiltered `getCandidateClaims()` value/order/reference parity with the
  current direct candidate-array read;
- public projection and safe-clone behavior already promised by query output;
- no new canonical record, receipt, audit event, node content, edge, or
  candidate mutation during query;
- the current `queryTrustGraph()` target-resolution path calls `getNode()` and
  therefore updates `lastAccessed` and may persist a SQLite touch; this existing
  side effect must be measured and preserved until a separately approved
  no-touch migration changes the caller and seam together;
- direct provenance and candidate scans must not invent an access-touch side
  effect where none currently exists.

The candidate-source migration is mechanical only after this parity passes.
Node and edge reads remain separately blocked until an exact bounded source is
approved.

### 3. Server workspace graph view

Owner: `server.test.js`.

Lock current `/graph-data` behavior for:

- default and authenticated non-default workspace isolation;
- raw edge insertion order before top-node filtering;
- top-150 node selection and existing score ordering;
- node `edgeCount`, confidence, sources, evidence count, and timestamps;
- link projection, evidence truncation, and workspace filtering;
- no cross-workspace node or edge leakage;
- no Graph mutation or node access-touch caused by the view.

Do not bless HTML/UI details unrelated to the JSON graph payload.

### 4. Plugin fact and entity inputs

Owners:

- `plugin.test.js` for shared plugin integration;
- focused plugin tests where already present;
- one new focused contract file only if the shared object-shape behavior is not
  expressible without duplicating unrelated plugin loading tests.

Lock current behavior for:

- the exact known-node object shape passed to `extractFacts()`;
- global visibility for the five fact-extraction plugin callers;
- explicit-workspace and normalized default-workspace filtering in
  company-brain; no all-workspace ranking behavior is claimed;
- storage-key identity where non-default workspaces are present;
- insertion order supplied to company-brain ranking;
- no mutation of Graph nodes by plugin input preparation.

The five fact-extraction callers are company-brain, contradiction-alert,
devil-advocate, discovery-engine, and idea-mri.

## Test Infrastructure Rules

- use isolated temporary paths;
- disable SQLite unless SQLite touch behavior is the explicit subject;
- when SQLite is required, spy or compare only the bounded statement/write
  evidence and close all resources;
- restore prototypes, clocks, console, environment, and process state in
  `finally`;
- do not read `_nodes`, `_edges`, or `_candidateClaims` in a future absence
  assertion that is expected to pass before implementation;
- baseline tests must be green on canonical source;
- no deliberately red seam-existence test is allowed.

## Successor Sequence

1. `REFACTOR-3B2A_BOUNDED_READ_BASELINE_TESTS`
   - add only missing green current-source assertions in the named owners;
   - change no runtime or declaration file.
2. `REFACTOR-3B2B_BOUNDED_READ_SEAMS_AND_CALLERS`
   - choose the minimum intent-specific seam from the executable evidence;
   - migrate only callers whose behavior is exactly preserved;
   - reuse `getCandidateClaims()` and company-brain's existing-workspace
     `getNodes(workspaceId)` before adding any method;
   - keep causal, provenance, server, and plugin changes independently
     reviewable even if they share one PR.
3. `REFACTOR-3B2C_READ_BOUNDARY_CLOSEOUT`
   - scan production, server, provenance, and plugin read callers assigned to
     this chain;
   - require zero unauthorized direct node/edge/candidate reads;
   - name and defer any source conflict that cannot be migrated safely.

Mutation owners in Dream, KernelV2, and Kernel consolidation remain assigned to
`REFACTOR-3B3_MUTATION_OWNERSHIP` and are forbidden in this chain.

Operational callers remain assigned to `REFACTOR-3B4_DIRECT_CALLER_CLOSEOUT`:

- `demo-causal-autolearn.js` direct node-label read;
- `egitim.js` global node/edge counts;
- `scripts/seed-demo.js` global edge count.

Their omission from REFACTOR-3B2 is deliberate. They may reuse exact existing
methods only after their output contract has an executable owner; they do not
block the production read-boundary closeout.

## Allowed Output

Only this task-pack document may change in REFACTOR-3B2.

## Forbidden Scope

- changes to runtime, test, declaration, schema, package, workflow, or Docker
  files;
- new public Kernel, KernelV2, Graph, server, provenance, or plugin API;
- generic snapshots, repositories, facades, adapters, iterators, callbacks, or
  collection aliases;
- Dream embedding, KernelV2 temporal metadata, or consolidation changes;
- changing workspace defaults, ordering, identity, defensive-copy,
  access-touch, persistence, or error behavior;
- demo/script cleanup, startup duplicate-load, `PERSISTENCE-PATH-ALIGNMENT`, V5,
  Policy Auditor, or product work.

## Stop Conditions

Stop and report `REFACTOR-3B2_BLOCKED_BY_READ_CONTRACT_CONFLICT` if:

- a green baseline cannot distinguish callers that currently touch through
  `getNode()` from direct no-touch reads;
- cross-workspace ordering or storage-key behavior is contradictory;
- the server payload depends on live mutable edge identity;
- plugin callers require different known-node shapes that cannot share a
  contract;
- a new seam would expose mutable collections or silently widen workspace
  visibility;
- implementation is required to make a baseline test pass;
- a new public API, schema, dependency, version, verdict, receipt, envelope, or
  product decision is required.

## Acceptance

- this document is the only changed file;
- every baseline is green on current canonical source;
- existing exact methods are explicitly reused;
- implementation and seam names remain unclaimed until tests exist;
- related and full suites have zero failures;
- Security Checks, Benchmark Regression, and Docker build pass;
- independent review confirms source and REFACTOR-3B consistency.

## Non-Claims

- no bounded Graph read seam was implemented;
- no caller was migrated;
- no direct Graph access was removed;
- no workspace, ordering, access-touch, or persistence contract changed;
- REFACTOR-3B, REFACTOR-3, and REFACTOR-4 are not complete;
- Policy Auditor has not started;
- the refactor program is not complete.
