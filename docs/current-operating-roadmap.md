# Current Operating Roadmap

**Audited live baseline:** `main` at
`0a1cc37011679e138e55a79ec47e2ebbd7503c14`.

This is an observation, not an implementation base pin. Live source, exact Git
SHA, tests and current CI outrank this compact execution source. Detailed
history remains in merged PRs, task-packs, ADRs and issue evidence.

## Current classification

HUQAN is a **local-first partial trust layer** with real graph, verification,
gates, provenance, durable approval/audit behavior, canonical receipts and
bounded Workbench trust surfaces.

The V4 Workbench runtime-evidence phase has completed its source/test/CI/package
closeout gate:

```text
V4_B5_SOURCE_TEST_CI_RELEASE_CLOSEOUT: PASS
```

This is a bounded phase-closeout claim. It is not a claim that every possible V4
product surface is universally mature, externally interoperable or deployed.

The controlling V5 entry decision is now:

```text
V5_IMPLEMENTATION_ENTRY: PASS
```

`docs/v5/v5-implementation-entry-successor-audit.md` records that verdict
against `b6ea911ef44ad9a762ad2a1b57a85a64281a580c` and supersedes the `FAIL` in
ADR-010 Decision 3 — and only that decision. Closing V4-B5 removed the
V4-closeout blocker; the successor audit satisfied the independent external
interoperability/conformance dependency by requiring the shipped Python verifier
to agree byte-for-byte with the JavaScript consumer across ATP 0.1 and HTP 0.2,
including exit status.

Entry is authorized. It is not completion: see the current V5 boundary below.

## Closed V4 evidence

| Gate | Controlling source evidence | Status |
| --- | --- | --- |
| V4-B1 | PR `#264`, candidate `262d357ef37a6d189dc29b1f255c90b7c6ccc745`; authenticated real-server + SQLite Workbench read evidence | `PASS` |
| V4-B2 | Runtime PR `#520` head `99847901411128b1a0515ed5da23589206716f06`; merge `e02eb03e79e10d6bc65e02322febe5eb2fd15055`; reconciliation PR `#523` merge `9b6d41f801a918451e3e5142498204d86a549f59`; issue `#270` closed | `PASS` |
| V4-B3 | PR `#588` head `5452a7680a2b3e96e5a288c928c64669cbe57cc9`; merge `75821f6dd4fa2f0efb0fc8669acb9c733954e5c0`; issue `#271` closed | `PASS` |
| V4-B4 | PR `#129` head `7127cccb14d63cb73b45c9d6fb6cfd33ef46e175`; merge `2d4920ae6231f4d9c1acb1767d4f0c08e1ed016a`; read-only Trust Receipt Viewer + no-mock Chromium client smoke | `PASS` |
| V4-B5 | `docs/v4-b5-source-test-ci-release-closeout.md` | `PASS` |

Notion `V4-B1..B4` is synchronized as `Pass` / completed before the B5 closeout.
B5 is synchronized after the closeout PR merges and its final merge SHA exists.

## Controlling runtime CI

The last V4 runtime-changing merge is PR `#588`. Its exact head is:

```text
5452a7680a2b3e96e5a288c928c64669cbe57cc9
```

Exact-head CI:

```text
Security Checks       31285073352  SUCCESS
Architecture Checks   31285073314  SUCCESS
Benchmark Regression  31285073318  SUCCESS
Node 20 npm test job  93172327986  SUCCESS
Node 22 npm test job  93172328153  SUCCESS
Docker build          93172454650  SUCCESS
```

Between PR `#588` merge
`75821f6dd4fa2f0efb0fc8669acb9c733954e5c0` and the audited B5 base
`0a1cc37011679e138e55a79ec47e2ebbd7503c14`, Git reports only two documentation
paths changed:

```text
docs/adr/ADR-010-v5-ecosystem-entry.md
docs/v5/README.md
```

So the runtime/test/package tree at the B5 source snapshot is identical to the
exact runtime tree that passed the CI above.

## V4-B2 bounded action / approval boundary

The closed B2 contract remains intentionally narrow:

- shared API-key HTTP action authority is canonical workspace `default` only;
- omitted workspace means `default`; supplied workspace must be exact `default`;
- the canonical workspace is persisted into the immutable approval snapshot and
  covered by its binding hash;
- manual and decision ingest remain the bounded action kinds;
- outcome is derived from admission evidence and observed Graph delta;
- malformed, contradictory, partial or uncertain outcomes persist as
  `execution_outcome_unknown`; and
- uncertain/failed outcomes are not automatically retried.

The hardened B2 security attestation is Security Checks run `31186846627`
`SUCCESS` at `b6bfd7cce2d8ca0753e75b02ffa7ca5c6b368bce`. PR `#520`'s own Security
run pre-dated the fail-hard workflow and is lifecycle evidence only.

## V4-B3 receipt boundary

The closed B3 contract is:

- authenticated `GET /api/workbench/receipt-bundle`;
- read-only;
- canonical workspace `default` only;
- verified before response bytes are written;
- maximum `1024` receipts;
- maximum `2 MiB` serialized UTF-8;
- no partial, truncated or paginated success on ceiling failure;
- corrupted/verifier-failed bundles fail closed; and
- `no-store` / `nosniff` response constraints preserved.

The exported B3 bundle is an **internal/full trust artifact**. It is not the
public-safe/redacted receipt exchange planned for later V5 work.

## V4-B4 client trust artifact

The read-only Trust Receipt Viewer from PR `#129` is the B5 client-facing trust
artifact. Its production viewer gateway and no-mock Chromium smoke establish a
real client surface with restrictive CSP/no-store and safe primitive rendering.

That evidence is deliberately classified as **client trust-artifact evidence**,
not as external interoperability proof.

## Package / release closeout

The full `npm test` suite contains the installed-tarball smoke in
`test/kernel-facade-contract.test.js`. It builds a real npm tarball, installs it
into a clean temporary consumer project, loads retained deep imports, executes
installed CLI `--help`, resolves packaged `better-sqlite3` and requires the
installed server.

Because that full suite passed on Node 20 and Node 22 at PR `#588` exact head,
V4-B5 records package/install release smoke `PASS`.

This does **not** claim npm registry publication, a release tag, deployment or
external distribution.

## Current V5 boundary

ADR-010 (`docs/adr/ADR-010-v5-ecosystem-entry.md`) controls the phase boundary:

```text
V4 = local/workbench trust runtime + product-runtime evidence
V5 = portable/external trust exchange + interoperability evidence
```

V5 has bounded library-level trust-object primitives and planning/spec material,
but library implementation is not production connector enforcement and local
fixtures are not external interoperability evidence.

The external interoperability/conformance dependency tracked by issue `#277`
(`V5-C5`) has been discharged by
`docs/v5/v5-implementation-entry-successor-audit.md`, which recorded:

```text
V5_IMPLEMENTATION_ENTRY: PASS
```

What that verdict authorizes is entry, and two concrete things follow from it:

- production wiring of the V5 modules still held in
  `lib/module-reachability.js::NOT_YET_WIRED`, each in its own scoped change;
- the gated V5 implementation track.

What it does not authorize is any claim of completion. A2A transport is
`SHIPPED_WITH_ONE_UNIT_DEFERRED` (`docs/v5/v5-p0-a2a-transport-closeout.md`),
every A2A route is deployment-gated and answers `404` while unconfigured, and no
third party has spoken to it.

## Naming and marketplace boundary

ATP/Axiom remains the live source-backed package/protocol lineage. No ATP->HTP
rename or migration is inferred or authorized by the V4 closeout.

Marketplace, Certified Node, public badges, reputation economy, public-safe
receipt exchange and GitHub App / Streaming Trust remain separate future gates.
Planning documents do not make those surfaces implemented or production-ready.

A2A exchange has left that list. Its bounded transport is shipped and mounted
(P0-B..P0-F, `docs/v5/v5-p0-a2a-transport-closeout.md`) and `npm run
conformance:a2a` holds at 52/52. Shipped and deployment-gated is still not
externally interoperable: nothing here claims a third party has connected.

## Current non-claims

Do not claim:

- universal V4 product maturity beyond the bounded Workbench closeout;
- external interoperability from local/product tests;
- V5 ecosystem implementation completion (entry is authorized; completion is not);
- all connectors V5-enforced;
- production Shared Trust Package transport from library-only modules;
- public-safe receipt exchange complete;
- A2A transport externally interoperable, deployed, or spoken to by a third party;
- GitHub App / Streaming Trust production-ready;
- Certified Node, TrustBench, public badge, reputation or marketplace live;
- ATP migrated to HTP;
- non-default HTTP workspace authority; or
- registry publication/deployment from package-install smoke.

## Execution rule

Every successor must start from live source and exact current `main`, read
`docs/agent-canon.md`, `docs/current-agent-checkpoint.json` and this roadmap,
then run `node scripts/agent-context.js` when a local Git worktree is available.

Connector-only work must report local bootstrap/worktree/Graphify as unverified
rather than manufacturing evidence. Every delivery carries exact scope, tests,
CI, review/merge identity, limitations and the next-agent envelope.
