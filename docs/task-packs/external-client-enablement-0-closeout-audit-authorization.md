# EXTERNAL-CLIENT-ENABLEMENT-0 CLOSEOUT AUDIT — Exact-Base Authorization

## Plan Check

- Repository: `ali-ulu/huqan`
- Package: `0.9.1` (unchanged)
- Exact authorization base: `main @ 1e733f57e333cd02e221d8e819eecd936bdfbca0`
- Route Adversarial-0 reviewed head:
  `a458ae995311125e17ef2ec5c530938bfddc87c5`
- Route Adversarial-0 merge: `4e681a5caec2d91ead9c1298da91c991c293dee0`
- Post-merge reconciliation head:
  `d09962a89480526d03e636f405c7d22e1fb55551`
- Post-merge reconciliation merge / live base:
  `1e733f57e333cd02e221d8e819eecd936bdfbca0`
- Checkpoint gate: `EXTERNAL_CLIENT_ENABLEMENT_0_CLOSEOUT_AUDIT_AUTHORIZATION`
- Governing sequence:
  `docs/task-packs/external-client-enablement-0-authorization.md`
- Mode: docs-only authorization for a source/test/CI closeout audit
- Runtime, test, fixture, workflow, package, route, server, deployment and
  release changes in this authorization PR: forbidden

The mutable checkpoint still records the preceding implementation merge as its
`canonicalMain`. Live Git source at `1e733f57e333cd02e221d8e819eecd936bdfbca0`
outranks that lagging field and is the only valid exact base for this
authorization.

## Source-Reality Finding

At the exact base:

1. The mandatory predecessor sequence has merged through Identity/Trust
   Config-0, Durable Replay-0, Mutation/Receipt Owner-0, HTTP Adapter-0 and
   Route Adversarial-0.
2. PR #241 reconstructed the authorized real-loopback proof using exactly three
   test-owned files and merged at exact reviewed head
   `a458ae995311125e17ef2ec5c530938bfddc87c5`.
3. PR #241 exact-head Security Checks `31014893750`, Benchmark Regression
   `31014894014` and full runtime test job `92336329914` succeeded.
4. The declared-overflow assertion remains exact `413`; the recovery made the
   test request truthful instead of weakening the contract to `400`.
5. `server.js` does not import the external-client endpoint contract or HTTP
   adapter and does not register `POST /api/external-client/packages/admit`.
6. The endpoint contract, trust configuration, durable replay owner,
   mutation/receipt owner and HTTP adapter remain production-unwired.
7. Generic API-key and rate-limit guards exist, but they are transport guards
   and do not establish external-client identity or authority.
8. The request boundary remains exactly `{ package, signature }`; identity,
   workspace, permissions, trusted keys, clock, replay, mutation and receipt
   ownership are pre-bound outside request bytes in the tested composition.
9. The package surface intentionally excludes the endpoint contract, trust
   materializer, replay owner, mutation/receipt owner and HTTP adapter while
   retaining the already published package-gate and Authority modules.
10. The receipt trust-root foundation preserves historical V1 evidence and
    bounds V2 ownership; no global production V2 writer or historical V1
    backfill is implied by the local route proof.
11. No production route, deployment configuration, replay path, trust-profile
    loader or public endpoint enablement has been selected.

Local clone bootstrap, `node scripts/agent-context.js`, worktree status and
Graphify refresh remain unverified in the connector-only environment. Live
source, exact Git ancestry, named tests and current CI control this audit.

## Decision

The closeout audit is initially **docs-only**. Its implementation may add one
report and may not repair any discovered defect.

The audit may close the bounded External Client Enablement-0 evidence program
while explicitly leaving production route registration and deployment
composition unselected. If source, tests, package surface, lineage or CI do not
support a required claim, the report must mark that boundary `BLOCKED` or
`UNVERIFIED` and stop before reconciliation.

## Authorized Implementation File

```text
docs/reports/external-client-enablement-0-closeout-audit.md
```

No other file is authorized in the audit implementation PR.

Read-only evidence owners include:

```text
AGENTS.md
docs/agent-canon.md
docs/current-agent-checkpoint.json
docs/current-operating-roadmap.md
docs/task-packs/external-client-enablement-0-use-case-decision.md
docs/task-packs/external-client-enablement-0-authorization.md
docs/task-packs/external-client-identity-trust-config-0*.md
docs/task-packs/external-client-durable-replay-0*.md
docs/task-packs/external-client-mutation-receipt-owner-0*.md
docs/task-packs/external-client-http-adapter-0*.md
docs/task-packs/external-client-route-adversarial-0*.md
lib/external-client-endpoint-contract.js
lib/external-client-trust-config.js
lib/external-client-replay-store.js
lib/external-client-package-gate.js
lib/external-client-authority.js
lib/external-client-mutation-receipt-owner.js
lib/external-client-http-adapter.js
lib/sdk.js
server.js
requestGuards.js
graph.js
package.json
lib/external-client-*.test.js
lib/sdk-external-package.test.js
test/external-client-route-adversarial.test.js
test/helpers/external-client-route-harness.js
test/helpers/external-client-route-fixture.js
.github/workflows/*.yml
```

Historical PR prose and task-packs are supporting evidence only. They do not
override live source, exact changed-file scope, test behavior or CI.

## Required Audit Matrix

### A. Exact Git and lineage ledger

Record:

1. the exact audit base and current `main` identity;
2. the ordered predecessor PR chain from Endpoint-0 through Route
   Adversarial-0 and its recovery/reconciliation PRs;
3. exact reviewed head and merge SHA for each material gate where available;
4. changed-file scope and negative scope for every runtime-bearing successor;
5. every closed, superseded or ancestry-stale PR that must not be treated as
   current evidence;
6. whether current runtime differs from the latest exact tested runtime head;
7. any missing, ambiguous or conflicting identity as a blocker.

### B. Production route and composition audit

Trace from live source:

1. whether `server.js` registers the reserved external-client path;
2. whether `server.js` imports or composes the endpoint contract, HTTP adapter,
   trust profile, trusted clock, durable replay path, SDK or mutation/receipt
   owner;
3. disabled/requested endpoint contract behavior and readiness bits;
4. whether any deployment or environment loader can make the route reachable;
5. whether any stable port, background worker, pending queue or asynchronous
   admission path exists;
6. whether generic API-key or rate-limit state is incorrectly treated as
   external-client identity or authority;
7. any hidden registration, alternate route or indirect composition as a
   blocking finding.

### C. Identity and trusted-key authority audit

Map live source and tests for:

1. one immutable server-owned client profile;
2. exact identity subject/kind, workspace, package scope and permission binding;
3. trusted-key loading, key ID, algorithm, validity interval, revocation and
   scope enforcement;
4. rejection of missing, malformed, unknown, revoked, stale, future-dated and
   wrong-scope authority;
5. resistance to inherited, accessor-backed, symbolic, hidden, prototype and
   request-body authority injection;
6. absence of a production profile loader or multi-client registry;
7. no trust-root inference from API key, actor text, transport metadata or
   package fields.

### D. Durable replay audit

Map live source and exact tests for:

1. SQLite-backed atomic reservation ownership;
2. required absolute path and fail-closed initialization;
3. restart persistence, expiry and concurrency behavior;
4. malformed or hostile dependency result handling;
5. distinction between Authority replay and Graph mutation-journal replay;
6. no process-memory or JSON fallback for positive durability claims;
7. no production replay-path wiring or multi-instance claim beyond tested
   evidence.

### E. Mutation and receipt ownership audit

Trace the bounded admitted mutation through live source:

1. exact quarantine mutation and application owner;
2. transaction/journal ordering and idempotent result ownership;
3. canonical V2 receipt creation and durable identifiers;
4. response, candidate, journal result and receipt identity agreement;
5. unknown or incomplete outcome behavior without automatic retry,
   compensation or rollback claims;
6. bounded `external_verified_client` ownership without global V2 enablement;
7. historical V1 byte/hash preservation and absence of backfill;
8. any alternate writer, bypass or ambiguous ownership as a blocker.

### F. HTTP adapter and transport audit

Map live source and tests for:

1. exact method, path-independent adapter input, content type and one-MiB byte
   limit;
2. declared and observed overflow returning exact `413` before delegation;
3. malformed length, duplicate/conflicting headers, invalid UTF-8, malformed
   JSON, depth and aggregate-value limits;
4. unknown envelope and caller-authority rejection;
5. bounded status/header/body mapping and no secret/internal leakage;
6. stream error, abort, close and timeout settlement;
7. native drain and bounded destroy fallback without duplicate settlement;
8. no adapter-owned socket, route, trust, replay, mutation or receipt semantics.

### G. Real-loopback adversarial evidence audit

Reconcile PR #241 exact-head source and CI for:

1. real server generic `404` under disabled/requested configuration;
2. rate-limit then API-key rejection before adapter/body/delegation;
3. exact `201` success and durable candidate/journal/receipt evidence;
4. one durable mutation under concurrent duplicate requests;
5. close/reopen replay rejection without second mutation;
6. distinct mutation-journal replay mapped to exact `200`;
7. malformed transport, envelope, signature, package, freshness, identity and
   workspace failures remaining mutation-free;
8. abort, replay failure, handler failure and mutation uncertainty never
   retrying;
9. resource cleanup, line budgets and package-boundary assertions;
10. the truthful declared-overflow request preserving rather than weakening
    the exact `413` contract.

### H. Package, dependency and deployment audit

Record from exact package and repository source:

1. package version and dependency set;
2. exact published/excluded external-client modules from `npm pack --dry-run`
   evidence;
3. absence of new export, public schema, status field, error vocabulary or
   package contract;
4. absence of deployment, TLS, proxy, internet, multi-client and production
   replay-path configuration;
5. whether any workflow or release source claims more than runtime proves.

### I. Test and CI evidence ledger

For every material claim:

1. name the exact source file and relevant test case or assertion group;
2. distinguish targeted evidence, related regression and full-suite evidence;
3. record exact tested head SHA and workflow run/job IDs;
4. state whether full `npm test` actually ran or was `NOT_APPLICABLE`;
5. identify skipped or unavailable evidence;
6. do not treat task-pack prose, PR prose or a green classifier as runtime
   proof;
7. classify connector-only local bootstrap, worktree and Graphify evidence as
   `UNVERIFIED`.

### J. Verdict and blocker ledger

Issue separate verdicts for:

1. predecessor Git lineage;
2. static identity/trusted-key authority;
3. durable replay ownership;
4. bounded mutation and receipt ownership;
5. thin adapter and transport fail-closed behavior;
6. real-loopback adversarial evidence;
7. production route absence;
8. package/dependency/deployment non-expansion;
9. historical V1 preservation and bounded V2 ownership;
10. overall External Client Enablement-0 evidence program;
11. production route enablement readiness;
12. V4 and V5 successor readiness.

Allowed verdict values are:

```text
CLOSED
BLOCKED
NOT_APPLICABLE
UNVERIFIED
```

The bounded evidence program may be `CLOSED` while production route enablement
remains `BLOCKED` or `NOT_APPLICABLE`. These verdicts must not be collapsed.

## Required Final Conclusions

The report must explicitly answer:

1. What is directly observed on exact current source?
2. What is derived only from unchanged-runtime ancestry?
3. What remains unverified in the connector-only environment?
4. Is the production route registered or reachable?
5. Is a production profile/clock/replay path/SDK/mutation composition wired?
6. Can request bytes select any authority?
7. Are replay and mutation-journal idempotency still distinct?
8. Is production V2 writing broader than the exact bounded owner?
9. Are historical V1 bytes/hashes/backfill unchanged?
10. What blockers remain before any production enablement decision?
11. What exact next gate is admissible after closeout reconciliation?

## Acceptance Commands

```bash
git diff --name-only 1e733f57e333cd02e221d8e819eecd936bdfbca0...HEAD
grep -nE 'Exact Git and lineage|Production route|Identity and trusted-key|Durable replay|Mutation and receipt|HTTP adapter|Real-loopback|Package, dependency|Test and CI|Verdict and blocker|BLOCKED|UNVERIFIED' docs/reports/external-client-enablement-0-closeout-audit.md
npm pack --dry-run --json --ignore-scripts
git diff --check
git status --short
```

Expected:

- exactly one added audit-report file;
- no runtime, test, fixture, workflow, package, checkpoint or deployment change;
- exact source/test/CI evidence for every material claim;
- production route and composition remain unimplemented unless live source
  proves otherwise;
- no readiness inflation, hidden implementation or historical rewrite.

## Stop Conditions

Stop and record `EXTERNAL_CLIENT_ENABLEMENT_0_CLOSEOUT_AUDIT_BLOCKED` if the
audit requires:

- any runtime, test, fixture, workflow, package, checkpoint or deployment file
  change;
- route registration, server composition or deployment configuration;
- a new trust profile, key loader, replay path, queue, retry or compensation;
- a new dependency, export, schema, public status, response field or error
  vocabulary;
- production V2 ownership beyond the existing bounded owner;
- historical V1 rewrite, rehash, classification or backfill;
- weakening exact `413`, fail-closed authority, replay, mutation or unknown
  outcome behavior;
- internet, TLS, proxy, multi-client or multi-instance claims;
- a claim that cannot be traced to exact live source, a named test and exact CI
  evidence.

Any repair or product enablement decision requires a separate exact-base gate.

## Definition of Done

This authorization closes only when:

1. exactly this authorization task-pack changes;
2. exact base, one-file future audit scope and read-only evidence owners are
   unambiguous;
3. every required audit matrix and verdict is specified;
4. production route, server composition and deployment remain forbidden;
5. exact-head docs CI and Security Checks are green;
6. source-first review finds no hidden implementation or readiness claim;
7. the authorization merges from its exact reviewed head; and
8. a separate reconciliation opens only
   `EXTERNAL_CLIENT_ENABLEMENT_0_CLOSEOUT_AUDIT` from exact post-merge `main`.

## Non-Claims

This authorization does not provide or authorize:

- a registered or reachable production external-client route;
- production trust-profile, clock, replay-path, SDK or mutation composition;
- request-controlled authority;
- multi-client, multi-instance, TLS, proxy or internet deployment;
- a pending queue, asynchronous admission, retry or compensation;
- a new public API, schema, status, error vocabulary, dependency or package
  surface;
- production V2 writing beyond the existing bounded owner;
- historical V1 rewrite, rehash or backfill;
- External Client Enablement-0 closeout before the separate audit and
  reconciliation merge;
- V4 Workbench completion;
- V5 ecosystem readiness or completion.
