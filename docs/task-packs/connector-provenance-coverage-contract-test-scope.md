# CONNECTOR-PROVENANCE-COVERAGE Contract Test Scope

## Plan Check

- Repository: `ali-ulu/huqan`
- Source base: `main @ dad8e55cdfb878d0ec6bb2a5f436b338c8f41ddf`
- Previous gate: `CONNECTOR_PROVENANCE_COVERAGE_SOURCE_REALITY`
- Active gate: `CONNECTOR_PROVENANCE_COVERAGE_CONTRACT_TEST_SCOPE`
- Mode: docs-only
- Runtime implementation: not authorized
- Successor: `CONNECTOR_PROVENANCE_COVERAGE_CONTRACT_TESTS`

The successor locks current connector behavior before any journal or provenance
migration. It reuses existing test owners and adds no new test file.

## Test Ownership

| Runtime path | Existing test owner | Successor coverage |
| --- | --- | --- |
| `adapters/github-adapter.js` -> `fetchRepoFiles()` | `adapters/github-adapter.test.js` | Preserve remote-read-only behavior and confirm no provenance, admission, audit, journal, or receipt result is invented. |
| `lib/github-connector.js` -> `ingestGitHubItem()` | `lib/github-connector.test.js` | Lock reachable candidate, admitted, and skipped outcomes, flagged conflict handling, invalid strict-input throw behavior, audit presence, workspace propagation, absent connector-generated operation id, and the current unconditional accepted-route `canonical` / `graphWrite` report. Do not fabricate a rejected public-path case. |
| `plugins/repo-memory.js` -> `ingestGithubRepo()` | `plugins/repo-memory.test.js` | Lock connector provenance, governed proposal admission, optional proposal `receiptId` propagation, and absence of connector-owned audit or generated operation id. |
| `plugins/repo-memory.js` -> `ingestMarkdownPath()` | `plugins/repo-memory.test.js` | Lock file/section provenance, workspace propagation, governed proposal admission, optional proposal `receiptId`, and the same audit/journal boundaries. |
| `adapters/markdown-adapter.js` -> `ingestAndLearn()` | `adapters/markdown-adapter.test.js` | Lock structural provenance shape, volatile identifier behavior without exact-value assertions, learn delegation, and absence of adapter-generated operation id or receipt guarantee. |
| `lib/provenance-ingest.js` -> `ingestWithProvenance()` | `lib/provenance-ingest.test.js` and `test/provenance-ingest.test.js` | Keep persistence/provenance and admission-result ownership separate; lock absence of a generated operation id and exact forwarding of a caller-supplied `mutationOperationId`. |
| `lib/ingest.js` -> `handleIngest()` and `buildIngestApprovalSnapshot()` | `test/ingest-snapshot-gate-boundary.test.js` and `server.test.js` | Lock direct GitHub and Markdown capability delegation, the pure snapshot refusal, and the existing approval-queue HTTP `INGEST_SNAPSHOT_REQUIRED` response. |

## Exact Writable Scope

The successor may modify only:

1. `adapters/github-adapter.test.js`
2. `adapters/markdown-adapter.test.js`
3. `lib/github-connector.test.js`
4. `lib/provenance-ingest.test.js`
5. `plugins/repo-memory.test.js`
6. `test/ingest-snapshot-gate-boundary.test.js`
7. `test/provenance-ingest.test.js`
8. `server.test.js`

Existing assertions must be extended, not rewritten. No new helper or test file
is authorized unless source isolation proves impossible and a separate scope
decision is approved.

## Required Contract Assertions

1. Keep provenance, admission, audit, graph mutation, durable journal, and
   receipt evidence as separate assertions.
2. Assert only path-owned behavior. A missing connector-owned receipt is not
   proof that a delegated Kernel result cannot contain a receipt.
3. For each path, assert which of generate, forward, or omit describes its
   current `mutationOperationId` behavior. Do not invent a generated case.
4. For generic Markdown provenance, assert type and structural shape only.
   Do not pin wall-clock or random values and do not call the path deterministic.
5. Record the GitHub connector's accepted-route `canonical: true` and
   `graphWrite: true` fields as current report shape, not proven graph truth.
6. Keep `handleIngest()` capability execution separate from
   `buildIngestApprovalSnapshot()` queue admission.
7. Preserve the external GitHub/Markdown
   `INGEST_SNAPSHOT_REQUIRED` refusal without a permissive fallback.
8. Use synthetic, local fixtures only. No network, system credential, live
   GitHub repository, externally persistent database, or hidden global state
   is allowed. Existing temporary-directory SQLite roundtrip coverage remains
   permitted and must clean up after itself.
9. Treat the internal rejected branch as unverified reachability. Testing it
   requires a separate contract decision if no public connector input can
   produce it without private injection or runtime modification.

## Validation

Run only the required targeted set:

```text
node --test adapters/github-adapter.test.js
node --test adapters/markdown-adapter.test.js
node --test lib/github-connector.test.js
node --test lib/provenance-ingest.test.js
node --test plugins/repo-memory.test.js
node --test test/ingest-snapshot-gate-boundary.test.js
node --test test/provenance-ingest.test.js
node --test server.test.js

node --test adapters/github-adapter.test.js adapters/markdown-adapter.test.js lib/github-connector.test.js lib/provenance-ingest.test.js plugins/repo-memory.test.js test/ingest-snapshot-gate-boundary.test.js test/provenance-ingest.test.js server.test.js
```

Per owner instruction, do not run the full suite, benchmark, or Docker for this
gate. Security Checks may still be used as the repository-level CI guard.

## Forbidden Scope

- connector or runtime implementation changes;
- new test files, helpers, schemas, fixtures, dependencies, or package changes;
- mutation-journal migration;
- new receipt, verdict, status, vocabulary, or public API;
- exact assertions over random identifiers or wall-clock timestamps;
- relaxing external-source snapshot requirements;
- network, credential, database, workflow, deployment, or version changes;
- universal connector, transactional, rollback, replay-safe, exactly-once, or
  V5-complete claims.

## Stop Conditions

Stop with `CONNECTOR_PROVENANCE_COVERAGE_CONTRACT_CONFLICT` if:

- current source and an existing test disagree;
- a green characterization requires a runtime change;
- isolation requires a ninth writable file;
- a new status, receipt, schema, fixture, dependency, or public API is needed;
- a connector path cannot be tested without network, credentials, or persistent
  external state;
- journal migration is required to describe current behavior;
- external GitHub or Markdown queueing would need a permissive fallback.

## Acceptance Criteria

- Exactly the eight existing test files own the successor implementation.
- Every required assertion is green against current source.
- No deliberately red test is added.
- No runtime or production file changes.
- Targeted individual and combined commands pass with zero failures.
- `git diff --check` passes and the worktree is clean after commit.

## Non-Claims

This scope does not prove or authorize universal connector coverage, durable or
transactional mutation coverage, receipt generation for every mutation,
immutable external-source snapshots, rollback, replay safety, exactly-once
execution, or V5 ecosystem completion.
