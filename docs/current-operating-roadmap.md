# Current Operating Roadmap

**Live baseline:** `main` at `ccc1a4869a6c84bcf90f4560fcf6c470860fdeab` (PR #97 merge, 2026-07-29).
**Full suite at this baseline:** 2152 tests — **2123 pass, 0 fail, 29 skipped**.

This is the single execution-order source for current work. It is not a release
claim and it does not replace architecture ADRs. When this file conflicts with
live source, tests, CI, or an exact merged SHA, the live evidence wins.

Status classes used below: `DONE` (merged evidence in `main`), `PARTIAL`
(some sub-gates merged, gate not closed), `NOT STARTED`, `SUPERSEDED`,
`BLOCKED` (blocked by binding order).

---

## 1. Where we are

HUQAN is a **local-first partial trust layer** with real graph, verification,
gate, provenance, audit, approval, and receipt primitives. It is not yet a
fully inline trust control plane for every client, connector, or mutation path.

Two work streams are live in `main` and both are real:

- **Stream A — Refactor programme.** Architecture decomposition, gates
  REFACTOR-0 through REFACTOR-4. Currently at REFACTOR-4E.
- **Stream B — Ingest / approval hardening.** PR #90–#97. Currently at
  INGEST-SNAPSHOT-0.

Neither blocks the other. Both must reach their closeout before the Policy
Auditor programme can begin.

---

## 2. What is done

### 2.1 Refactor programme (Stream A)

| Gate | Status | Evidence in `main` |
| --- | --- | --- |
| REFACTOR-0A / 0B / 0C | `DONE` | Source, boundary and facade contract audits merged |
| REFACTOR-1, 1A0, 1A1, 1A2, 1A, 1B | `DONE` | Public Kernel seam scope, type alignment, constructor reconciliation, facade contract tests |
| REFACTOR-1C | `DONE` | PR #17 at `b00dde2aa2f71c3bb6c257b7c710ec62eb9a56ad`; CLI→Graph coupling inventory |
| REFACTOR-1C1 CLI Graph read contract | `DONE` | `refactor/cli-graph-read-contract-tests`, `refactor/cli-graph-source-boundary` merged |
| REFACTOR-1C2 Lifecycle / maintenance seam | `DONE` | `kernel.getPersistenceDescriptor()` (kernel.js:1824); `refactor/cli-lifecycle-maintenance-seam-migration` merged |
| REFACTOR-1C3 CLI audit seam | `DONE` | `kernel.recordCliMutationAudit(intent)` (kernel.js:602); `refactor/cli-audit-callsite-migration` merged |
| REFACTOR-1C4 Mechanical CLI migration | `DONE` | **`cli.js` has zero direct Graph access** — no `graph._nodes`, `_edges`, `.load()`, `.save()`, `.optimize()`, `.memoryPath`, `.appendAuditEvent()`. This is the REFACTOR-1C4 acceptance criterion, met. |
| REFACTOR-2A / 2B Inventory + use-case contract | `DONE` | Responsibility inventory and application use-case contract merged |
| REFACTOR-2C Read use-case extraction | `DONE` | `lib/kernel-read-use-cases.js`; `ask`, `entropy`, `detectGaps`, `reason`, `compare`, `getPersistenceDescriptor` all delegate |
| REFACTOR-2E Learn / memory-admission extraction | `DONE` | `lib/learn-use-case.js`; `refactor/2e3-learn-use-case-extraction`, `2e4-learn-type-alignment` merged |
| REFACTOR-2G Consumer migration | `PARTIAL` | `refactor/capability-consumer-migration` merged; full surface sweep not evidenced |
| REFACTOR-3A / 3B Source reality + persistence port | `DONE` | Graph/memory-store source reality, bounded read contracts, mutation ownership scope merged |
| REFACTOR-3B1–3B3 Caller migrations | `DONE` | `3b1-exact-existing-method-migrations`, `3b2b-bounded-read-callers`, `3b3b-dream-embedding-ownership`, `3b3c-temporal-metadata-ownership`, `3b3d-consolidation-ownership` all merged |
| REFACTOR-4A Surface parity inventory | `DONE` | Merged |
| REFACTOR-4B Surface contract convergence | `DONE` | PR #68–#70; closeout `REFACTOR-4B4_BYPASS_NEGATIVE_AND_CLOSEOUT_EVIDENCE`; `TRANSPORT_BYPASS_CLOSED` for REST upload aliases |
| REFACTOR-4C Package / type surface | `DONE` | 4C0 source reality + `refactor/4c1-package-type-surface` merged |
| REFACTOR-4D Plugin candidate-only boundary | `DONE` | PR #74–#87; company-brain, contradiction-alert, discovery-engine, idea-mri, devil-advocate all migrated off private `graph._nodes` |

### 2.2 Ingest / approval hardening (Stream B)

| Merged PR | Completed boundary | Deliberate limit |
| --- | --- | --- |
| #90 / #91 | CLI one-shot and persisted approval workflow | Does not prove every external client path |
| #92 | Plugin ingest status reports admission truthfully | Status is not a universal ingest proof |
| #93 | Atomic approval claim for persisted MCP approvals | Claim alone is not durable mutation evidence |
| #94 | Durable mutation journal and hash-chained canonical receipts on its integrated path | Not every plugin mutation uses this path |
| #95 | HTTP ingest approval queue for manual and decision snapshots | GitHub and markdown ingest remain fail-closed |
| #96 | Expiring HTTP ingest execution leases with visible failed recovery | Failure means execution outcome is unknown, not rollback or transactionality |
| #97 | This roadmap file as the in-repo authority | Supersedes status posters; changes no runtime |

### 2.3 Product phases (V1–V6)

| Phase | Status | Evidence |
| --- | --- | --- |
| V1 Trust Kernel | `DONE` | `lib/verify.js`, `lib/receipt/*`, `provenance-query.js`, `reasoning-trace.js`, `causalSimulator.js` |
| V2 Action Boundary | `DONE` | `lib/action-risk-classifier.js`, `toolPolicy.js`, `sandboxRunner.js`, `lib/verdict/action-verdict.js` |
| V3 Approval Runtime + Memory Admission | `PARTIAL` | Core complete; Stream B is its live continuation. Gate: INGEST-SNAPSHOT-0 |
| V4 Workbench / Trust Runtime | `PARTIAL` | `lib/workbench/trust-receipt-inspector.js`, `memory-context-inspector.js`; `docs/v4/v4-runtime-surface-closeout.md` closes PR2→PR5 as a checkpoint. Product closeout (packaged pilot-ready flow, onboarding, WB3 decision) not done |
| V5 Ecosystem / Shared Trust Layer | `PARTIAL` | Identity/signing/verification foundation is real: `lib/v5/` — 7 modules (runtime writer/reader, structural signing helper, verification core, trusted-key resolver, crypto profile contract, crypto verification adapter) with 20+ test files. Of the 18 numbered ecosystem areas, **3 have code** — ATP legacy compatibility and conformance suite (`lib/atp-conformance.js`, `packages/axiom-verify`) and `.axiom` package exchange (`lib/axiom-package-format.js` + the V5 runtime writer/reader). The other **15 have none** |
| V6 Trust Plane / Trust Anchor | `NOT STARTED` | No source. Entry conditions unmet |

### 2.4 Non-claims enforced in code, not only documented

`lib/v5/runtime-writer.js` and `runtime-reader.js` map an incoming
`a2aTransport` / `a2aTransportEnabled` claim to `a2a_transport_claim`, and
`marketplaceReady` / `marketplaceImplemented` to `marketplace_claim`, then
resolve both to **`unsupported_claim`**. The V5 areas that are not built cannot
be asserted as trusted through the runtime writer. Treat this as the reference
pattern when adding a new V5 area: the claim must be rejected until the area
has evidence.

### 2.5 Off-roadmap code that exists

`lib/self-healer/` contains 717 lines across `audit-runner.js`,
`finding-classifier.js`, `finding-schema.js`, `index.js` — merged at
`05d0717`. The roadmap classifies Self-Healer as a deferred parallel lane.

**It is merged but not wired. Verified:**

| Check | Result |
| --- | --- |
| Runtime callers | **None.** The only `require`s are 5 lines across 3 files under `test/` |
| `index.js` consumers | **None** — not even the tests require it; they reach the submodules directly |
| Shipped to npm | **No.** `package.json` `files` lists 55 `lib/` entries and none for `lib/self-healer/` |
| Write surface | **None.** No `fs`, `child_process`, `http`/`https`, or `net` import in any of the four files |
| Execution modes | `AUDIT_MODES` is frozen to `['audit_only']` (audit-runner.js:12) |
| File output | Refused unless explicitly allowed — `outputPath is disabled in audit_only mode` (audit-runner.js:61) |
| Tests | 47 tests, 47 pass, 0 fail |

So the apparent contradiction between "deferred" and "717 lines merged" is a
**merged vs. wired** confusion, not a documentation error. The roadmap's
`deferred` classification is accurate for runtime. `ADR-007` already records
"Implementation status: Partial", which matches the source.

Consequence for the decision: marking it dormant removes no running behaviour,
and adopting it into a gate adds no new mutation risk on its own — it has no
write surface today, so any gate would have to introduce I/O deliberately.

---

## 3. What is next

### 3.1 Stream A — next gates

1. **REFACTOR-2D / 2F** — judgment/action and receipt/audit use-case
   extraction. `PARTIAL`: scope and ownership-alignment docs are merged, but
   no `lib/*-use-case.js` file exists for verify-claim or capability
   execution, unlike the read and learn use cases. Finish the extraction to
   match 2C/2E.
2. **REFACTOR-2H / 2I** — public facade compatibility tests, then
   `REFACTOR-2_CLOSEOUT_AUDIT_GREEN`.
3. **REFACTOR-3C–3I** — query/read model, mutation model, memory store split,
   scoring boundary, **performance baseline** (3H measures, does not
   optimise), then `REFACTOR-3_CLOSEOUT_AUDIT_GREEN`.
4. **REFACTOR-4E** — adapter isolation (SQLite, filesystem, Rust graph,
   signing/key store, MCP provider). **This is the current Stream A gate.**
5. **REFACTOR-4F** — cross-platform install/release smoke. The test gate this
   gate is often assumed to be missing **already exists**: `benchmark.yml`
   defines a job literally named `npm test (runtime/test)` that runs
   `npm ci --include=optional` then `npm test` whenever a runtime or test file
   changes, with a paired skip job reporting `NOT_APPLICABLE` so branch
   protection always sees the check. `better-sqlite3` is a normal
   `dependency`, so CI installs it and the suite is complete there. What 4F
   still owes is the *cross-platform* dimension — the current matrix is
   `ubuntu-latest` only, with no Windows or macOS run and no `npm ci` install
   smoke on those platforms, while `engines.node` is `>=18`.
6. **REFACTOR-4G** — architecture documentation reconciliation.
   `docs/architecture/` holds one file; the roadmap requires architecture,
   source-of-truth, package API, migration and non-claims docs to match source.
7. **REFACTOR-4H** — `REFACTOR-PROGRAM-CLOSEOUT-AUDIT-GREEN`.

Closeout criteria for 4H, unchanged: no surface imports Graph internals; no
plugin mutates canonical state directly; Kernel facade and types agree;
persistence ownership is singular; full suite green; no unexplained benchmark
regression; clean installs proven; architecture docs match source.

### 3.2 Stream B — next gates

1. **INGEST-SNAPSHOT-0** — before enabling GitHub or markdown ingest:
   immutable content snapshot, source identity, commit SHA or file hash,
   immutable approval reference, replay protection. **Current Stream B gate.
   No PR opened.**
2. **MCP dogfood proof** — run a real MCP client through queue, decision,
   receipt, restart and replay; preserve the evidence.
3. **Connector provenance coverage** — close only evidenced gaps in the
   connector-to-provenance/audit/graph chain.
4. **Mutation-journal decision** — decide whether company-brain and other
   direct plugin mutations must migrate to the durable journal. This is a
   migration/transaction design gate, not a follow-up patch.

### 3.2a INGEST-SNAPSHOT-0 — source reality, verified

What already holds, and should not be rebuilt:

- The queued snapshot is re-hashed and compared immediately before execution
  (`server.js:1162`), so the executed payload is the reviewed payload.
- Snapshot hashing is key-order independent via `stableStringify`
  (`lib/ingest.js:21`), so the hash is deterministic.
- Uniqueness is enforced in the database — `approval_key` carries a UNIQUE
  constraint (`storage.js:106`).
- Lease claim, heartbeat and expiry recovery are compare-and-swap based and
  covered by tests (`storage.js:597-671`).
- The receipt states `state_transition_not_asserted` (`server.js:1200`) rather
  than claiming a committed graph write.
- The fail-closed gate is a single explicit branch (`lib/ingest.js:150-153`)
  and is **not bypassable today**: `handleIngest` has exactly one runtime
  caller (`server.js:1179`) and that call happens after the gate, on
  `snapshot.payload`. Every other caller is a test. It stays exported and
  type-permissive, so a future direct caller could route around it — worth a
  boundary test, not a live defect.

Gaps this gate must close:

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | No commit SHA captured; GitHub content read by branch name | `adapters/github-adapter.js:71,96,112` |
| G2 | Content fetched at approval time, not queue time — reviewed content and executed content can differ | `plugins/repo-memory.js:152,349` |
| G3 | Markdown path has no per-file hash | — |
| G4 | `approvalKey` embeds `snapshotHash`, so same client key + different content does not collide — it silently opens a **second** approval instead of raising a conflict | `server.js:1234` |
| G5 | Key derivation is sha1 truncated to 16 hex chars — 64 bits | `lib/ingest.js:18` |
| G6 | No TTL, no nonce, no `Idempotency-Key` header — replay surface empty | — |
| G7 | `actor` hardcoded `'http-api'`, `workspaceId` `'default'` — requester and approver indistinguishable | `server.js:1135,1196` |
| G8 | `metadata.auditRefs` always written empty — receipt↔audit link is one-way | `server.js:1198` |

G1–G3 are the reason this gate exists: without commit-SHA or file-hash
binding there is nothing immutable to bind an approval to.

### 3.2b REFACTOR-4E — adapter leak, verified

The clearest violation of 4E's acceptance criterion sits in a surface, not a
domain module: `mcpServer.js:995-1001` branches on
`kernel.graph.getStats().backend === 'sqlite'` and binds
`mutationOperationId` only in that case. It is deliberate and carries an
explaining comment — JSON graph mode cannot provide a crash-safe journal — so
it is a design decision, not an oversight. It is still an adapter-specific
conditional inside a transport surface, and the consequence is real: under a
JSON backend an approval executes without the durable journal and nothing in
the response says so. 4E has to move this decision behind a port and make the
degraded mode visible rather than implicit.

Adapter identity also travels outward: `backend: 'sqlite'|'json'` flows from
`graph.js:1184` into `kernel.js:445` result metadata and reaches the MCP
schema at `mcpServer.js:148`, making the storage adapter part of an external
protocol contract.

**Correction to an earlier draft of this analysis:** plugin loading is *not*
fail-open. `strictPlugins` defaults to **true** (`plugin.js:133-134`) and is
disabled only by explicitly setting `AXIOM_PLUGIN_STRICT=0`. Verified by
execution: in a default environment a manifest-less plugin is `rejected`; only
with `AXIOM_PLUGIN_STRICT=0` does it load as `unverified`. The real and much
narrower gap is that HMAC signature checking runs only when
`AXIOM_PLUGIN_SIGNING_KEY` is set — without a key you get manifest-hash
integrity but nothing binding the manifest itself to a signer.

Unrelated find: `kernel.js:187` assigns `this._rust` and nothing in the
repository ever reads it.

### 3.3 Blocked until both streams close

Policy Auditor (`POLICY-IR-0` … `POLICY-IR-5`), Policy Compiler, Action
Integrity, COMPAT-0, productization, pilots, V5 ecosystem closeout, V6.

`lib/policy-audit/` and `docs/policy-audit/` do not exist. The binding order
holds: **Policy Auditor starts only after `REFACTOR-PROGRAM-CLOSEOUT-AUDIT-GREEN`.**

### 3.4 Two decisions needed from the owner

1. **`refactor/kernel-lifecycle-maintenance-seams` @ `29f2828`** (2026-07-18)
   is `SUPERSEDED` and carries **nothing `main` lacks**. Verified by diffing
   the branch against its merge-base: it is a single commit adding 301 lines
   across five files, and every one of them is already present in `main`.

   | What the branch would add | State in `main` |
   | --- | --- |
   | `kernel.getPersistenceDescriptor()` | present, kernel.js:1824 |
   | `kernel.reload()` | present, kernel.js:1828 |
   | `kernel.persist()` | present, kernel.js:1832 |
   | `kernel.optimize()` | present, kernel.js:1836 |
   | Type signatures for all four | present in `kernel.d.ts` |
   | `test/kernel-lifecycle-maintenance-seam-contract.test.js` | present, 12 tests |

   The seam is additionally covered by `kernel-facade-contract.test.js` (26
   tests), `kernel-read-use-cases-contract.test.js` (5) and
   `kernel-cli-audit-baseline-contract.test.js`. Deleting the branch loses no
   code and no test coverage; `29f2828` is recorded here if it is ever needed.

   Status posters describing `REFACTOR-1C2C_APPROVED_FOR_EXACT_HEAD_MERGE` as
   the current checkpoint describe this stale branch tip, not `main`.
2. **`lib/self-healer/`** — adopt into a gate with a scope definition, or mark
   dormant. The evidence needed for this call is now in §2.5: the code is
   merged, read-only, unshipped, and reachable from no runtime path. Either
   choice is safe; leaving it undecided is what keeps producing the false
   "roadmap says deferred but the code is there" contradiction.

---

## 4. Explicit non-goals until the gates above close

- No automatic retry of an approval whose execution outcome is unknown.
- No claim that every plugin mutation is durable or transactional.
- No external-source ingest without immutable source binding.
- No auto-fix, auto-merge, or release/deploy expansion.
- No Policy Auditor, Policy Compiler or Action Integrity work.
- No claim that V4 Workbench or V5 ecosystem is closed.

## 5. Operating discipline

One PR has one purpose. Each runtime PR must carry exact base/head, targeted
tests, full CI, review evidence, merge SHA, and post-merge smoke. Update this
file only when that evidence changes the current execution order.

**`better-sqlite3` is required to run the suite.** It is a normal `dependency`,
so `npm ci` installs it and CI is unaffected. A local checkout that skipped it
fails 79 SQLite-backed tests — that is a missing native module, not a code
regression. Install it before judging a red suite.

## 6. Verification commands

```bash
git fetch origin main && git rev-parse origin/main
# expect ccc1a4869a6c84bcf90f4560fcf6c470860fdeab

grep -c "graph\._nodes\|graph\.load()\|graph\.appendAuditEvent" cli.js
# expect 0 — REFACTOR-1C4 acceptance criterion

grep -n "recordCliMutationAudit\|getPersistenceDescriptor" kernel.js
# expect both present — REFACTOR-1C2 and 1C3 seams

npm install better-sqlite3 --no-save && npm test
# expect 2152 tests, 2123 pass, 0 fail, 29 skipped
```
