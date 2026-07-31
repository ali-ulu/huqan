# CONNECTOR-PROVENANCE-COVERAGE Source Reality

## Plan Check

- Repository: `ali-ulu/huqan`
- Source base: `main @ efe388dd9c919bfc43851fe24f31735e4c434c38`
- Roadmap gate: `CONNECTOR_PROVENANCE_COVERAGE`
- Mode: docs-only source-reality and test-scope definition
- Runtime implementation: not authorized
- Successor: `CONNECTOR_PROVENANCE_COVERAGE_CONTRACT_TESTS`

This task-pack records only behavior observed in the current source. It does
not claim universal connector coverage or authorize durable-journal migration.

## Terms

| Term | Meaning in this gate |
| --- | --- |
| Provenance | Source identity and trust-policy metadata built by `lib/provenance-ingest.js`. |
| Admission | The reported outcome of a governed proposal or learn operation. |
| Audit | An event appended to the Graph audit surface. |
| Graph mutation | A node, edge, candidate, or learned fact written to Graph state. |
| Durable journal | `Graph.runMutationOnce()` and its operation/receipt persistence contract. |
| Receipt | A canonical or query-time evidence object; presence of provenance or audit data alone is not a durable mutation receipt. |

These terms are not interchangeable.

## Observed Connector Matrix

| Path | Provenance | Admission | Audit | Graph mutation | Durable journal | Receipt reference |
| --- | --- | --- | --- | --- | --- | --- |
| `adapters/github-adapter.js` → `fetchRepoFiles()` | None; this is a remote read adapter | Not applicable | None | None | None | None |
| `lib/github-connector.js` → `ingestGitHubItem()` | `buildGitHubProvenance()` | Explicit candidate, admitted, rejected, or skipped result. The accepted route currently reports `canonical: true` and `graphWrite: true` as unconditional connector fields rather than deriving them from the route result. | `appendAudit()` records import/conflict decisions when an audit surface exists | Candidate routing; the accepted route delegates to the governed candidate path | No connector-generated operation id or connector-local `runMutationOnce()` contract observed | No connector-owned receipt guarantee observed |
| `plugins/repo-memory.js` → `ingestGithubRepo()` | `buildConnectorProvenance()` for repository, file, and section records | `buildGraphAdmissionRecord()` summarizes `proposeNode()` / `proposeEdge()` results | No connector-level audit contract observed | Governed node and edge proposals | No connector-generated operation id or connector-local `runMutationOnce()` contract observed | Proposal admission `receiptId` is propagated when present; presence is not guaranteed |
| `plugins/repo-memory.js` → `ingestMarkdownPath()` | File and section provenance | Same proposal admission summary | No connector-level audit contract observed | Governed node and edge proposals | No connector-generated operation id or connector-local `runMutationOnce()` contract observed | Proposal admission `receiptId` is propagated when present; presence is not guaranteed |
| `adapters/markdown-adapter.js` → `ingestAndLearn()` | The adapter builds its own provenance object. Its current `provenanceId` uses `Date.now()` and `Math.random()`, and `sourceType: markdown` does not pass through `buildProvenance()` normalization. | Learn result only | No adapter-owned audit contract observed | Depends on `kernel.learn()` | No adapter-generated mutation operation id observed | No adapter-owned receipt guarantee observed |
| `lib/provenance-ingest.js` → `ingestWithProvenance()` | Builds and validates provenance, including strict mode | Explicit learn admission summary | No module-owned audit contract observed | Delegates to `kernel.learn()` | The module does not generate an operation id, but a caller-supplied `mutationOperationId` remains in `learnOpts` and may activate the Kernel journal path | Any receipt belongs to the delegated learn result; the module does not guarantee one |
| `lib/ingest.js` → `runIngest()` | Delegated to the selected capability | Capability result | Delegated | GitHub and markdown can reach the `repoMemory` capability through this non-queue helper | No additional journal contract observed in this helper | No helper-owned receipt guarantee observed |
| `lib/ingest.js` → `buildIngestApprovalSnapshot()` | Requires an immutable bounded snapshot for queue admission | Rejects unsupported external snapshot sources | Queue-owned | No graph mutation in the rejected GitHub/markdown case | Not applicable to the rejected case | Not applicable to the rejected case |

## Source-Reality Findings

1. GitHub has two materially different ingest surfaces:
   `lib/github-connector.js` routes candidate claims, while
   `plugins/repo-memory.js` proposes repository graph nodes and edges. They
   must not be represented as one proven execution boundary.
2. `repo-memory` reports the admission truth returned by `Kernel` proposal
   methods. That is evidence of governed proposal outcomes, not evidence that
   the mutation is journaled, transactional, or replay-safe.
3. Generic markdown ingestion creates a volatile provenance id from wall-clock
   time and randomness. Current-source characterization must not pretend this
   path is deterministic.
4. Provenance ingestion does not generate a durable mutation operation id, but
   it preserves a caller-supplied `mutationOperationId`; absence of journaling
   cannot be stated as an unconditional module invariant.
5. The GitHub connector's accepted route reports `canonical: true` and
   `graphWrite: true` unconditionally. A characterization test may record this
   as current behavior, but must not treat it as independently proven mutation
   truth.
6. Provenance metadata, audit events, graph admission results, durable journal
   entries, and receipt references are distinct evidence layers.
7. `runIngest()` and approval-queue snapshot construction are different
   boundaries. `runIngest()` can delegate GitHub and markdown to `repoMemory`;
   `buildIngestApprovalSnapshot()` rejects those source types without an
   immutable snapshot.

## Next Test Gate

`CONNECTOR_PROVENANCE_COVERAGE_CONTRACT_TESTS` should add characterization
tests before any runtime migration.

The tests must lock:

1. the exact connector-path matrix above;
2. provenance and workspace propagation for each path;
3. admission truth for admitted, candidate, rejected, and skipped outcomes
   where the path supports them;
4. the presence or absence of connector-owned audit events;
5. whether each module generates, forwards, or omits a mutation operation id;
6. the distinction between candidate routing and direct graph proposals;
7. the unchanged `INGEST_SNAPSHOT_REQUIRED` result from
   `buildIngestApprovalSnapshot()` and its approval-queue HTTP caller for
   external GitHub and markdown requests;
8. deterministic results only on paths whose time and identifiers are bounded
   or injectable;
9. structural invariants, rather than exact identifiers, for the currently
   nondeterministic generic markdown-adapter path;
10. the unconditional current `canonical` and `graphWrite` report on the
    accepted GitHub connector route, without promoting it to proven graph
    mutation truth.

Tests must not be deliberately red. If current behavior cannot be described
without inventing a new status, receipt, or public API, stop and open a
contract decision gate.

## Allowed Scope

For the successor test-scope gate, read access may cover:

- `docs/current-operating-roadmap.md`
- `lib/github-connector.js`
- `plugins/repo-memory.js`
- `adapters/github-adapter.js`
- `adapters/markdown-adapter.js`
- `lib/provenance-ingest.js`
- `lib/ingest.js`
- `kernel.js`
- `graph.js`
- directly owned connector, provenance, ingest, journal, and receipt tests

The exact writable test file set must be named by a separate authorization.

## Forbidden Scope

- connector or runtime implementation changes;
- mutation-journal migration;
- new receipt, verdict, status, schema, or public API;
- relaxing external-source snapshot requirements;
- package, dependency, workflow, deployment, or version changes;
- claims about all connectors, plugins, mutations, or receipts;
- V5-complete, transactional, rollback, or exactly-once claims.

## Stop Conditions

Stop with `CONNECTOR_PROVENANCE_COVERAGE_CONTRACT_CONFLICT` if:

- observed source and current tests disagree;
- a test requires a new public behavior or vocabulary;
- a connector path cannot be isolated without runtime modification;
- journal migration is required to describe current behavior;
- external GitHub or markdown ingest would need a permissive fallback;
- the writable scope would cross connector ownership boundaries.

## Non-Claims

This document does not prove:

- universal connector provenance coverage;
- durable or transactional mutation coverage;
- receipt generation for every connector mutation;
- immutable snapshot binding for external GitHub or markdown content;
- replay safety, rollback, or exactly-once execution;
- V5 ecosystem readiness or V5 completion.
