# V4-B5 Source / Test / CI / Release Closeout

## Decision

```text
V4_B5_SOURCE_TEST_CI_RELEASE_CLOSEOUT: PASS
```

This is the closeout decision for GitHub issue `#272` / Notion task `V4-B5`.
It closes the **V4 Workbench runtime-evidence phase** against the exact source
and CI evidence below. It does not claim universal product maturity, external
interoperability, marketplace readiness, or V5 implementation authorization.

## Audit snapshot

```text
repository: ali-ulu/huqan
package: 0.9.1
canonical main audited: 0a1cc37011679e138e55a79ec47e2ebbd7503c14
last runtime-changing V4-B3 merge: 75821f6dd4fa2f0efb0fc8669acb9c733954e5c0
```

`0a1cc37011679e138e55a79ec47e2ebbd7503c14` is three commits ahead of the
V4-B3 runtime merge and the diff contains only:

- `docs/adr/ADR-010-v5-ecosystem-entry.md`; and
- `docs/v5/README.md`.

Therefore the runtime/test/package tree audited by the V4-B3 exact-head CI is
unchanged at this closeout source snapshot.

Authority follows `docs/agent-canon.md`: live source, exact Git identity, tests
and current CI outrank roadmap/checkpoint prose.

## Prerequisite status

The V4-B1..B4 roadmap prerequisites are all recorded `Pass` / completed.

| Gate | Source-backed closeout evidence | Result |
| --- | --- | --- |
| V4-B1 | PR `#264`; candidate `262d357ef37a6d189dc29b1f255c90b7c6ccc745`; authenticated real-server + SQLite Workbench read smoke; exact-head Security/Benchmark/full-suite evidence recorded in its closeout | `PASS` |
| V4-B2 | Runtime PR `#520` head `99847901411128b1a0515ed5da23589206716f06`, merge `e02eb03e79e10d6bc65e02322febe5eb2fd15055`; reconciliation PR `#523` merge `9b6d41f801a918451e3e5142498204d86a549f59`; issue `#270` closed | `PASS` |
| V4-B3 | PR `#588` head `5452a7680a2b3e96e5a288c928c64669cbe57cc9`, merge `75821f6dd4fa2f0efb0fc8669acb9c733954e5c0`; issue `#271` closed | `PASS` |
| V4-B4 | PR `#129` head `7127cccb14d63cb73b45c9d6fb6cfd33ef46e175`, merge `2d4920ae6231f4d9c1acb1767d4f0c08e1ed016a`; read-only Trust Receipt Viewer + no-mock Chromium client smoke | `PASS` |

## Acceptance evidence

### 1. Product runtime evidence — PASS

V4-B1 proves authenticated Workbench read behavior over real runtime/storage.
V4-B2 proves the bounded action/approval path over real `server.js`, Kernel,
SQLite Graph and durable approval state. V4-B3 proves the authenticated
Workbench receipt-bundle route is reachable through the product read router.
V4-B4 proves the client-facing read-only receipt viewer against the production
viewer gateway.

No acceptance row is satisfied only by a planning document.

### 2. Action / approval bounded — PASS

The V4-B2 repair binds canonical workspace `default` into the immutable approval
snapshot and its binding hash. Omitted workspace means `default`; any supplied
value must be the exact string `default`. Padded/non-string/non-default identity
fails before persistence.

The bounded Workbench action owner derives outcome from admission evidence and
observed Graph delta. Unknown, contradictory, malformed or throwing cases are
persisted as `execution_outcome_unknown` and are not automatically retried.
Generic plugin return is not upgraded into reviewed-external execution proof.

Controlling evidence:

```text
PR #520 Benchmark Regression: 31181386707 SUCCESS
PR #520 Architecture Checks:   31181386832 SUCCESS
hardened Security attestation: 31186846627 SUCCESS
```

The PR `#520` Security run itself pre-dated the fail-hard workflow and is kept as
lifecycle evidence only; hardened security evidence is the post-`#510` run
`31186846627`.

### 3. Receipt-flow smoke — PASS

PR `#588` establishes `GET /api/workbench/receipt-bundle` as an authenticated,
read-only, canonical-`default` Workbench route. Verification must accept the
bundle before response bytes escape.

Observed adversarial/flow evidence recorded by the B3 closeout:

- zero receipts -> `200` with an empty verified bundle;
- invalid workspace rejected before receipt read;
- corrupted chain -> `409` with no bundle;
- verifier failure -> `409` with no bundle;
- more than `1024` receipts -> `413`, no partial/truncated bundle;
- more than `2 MiB` serialized UTF-8 -> `413`, no partial/truncated bundle;
- private exception/source detail is not leaked; and
- `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` are preserved.

B3 verdict:

```text
V4_B3_RECEIPT_EXPORT_USER_FLOW_SUFFICIENT
```

### 4. External / client trust artifact — PASS with explicit boundary

V4-B4's Trust Receipt Viewer is the required **client trust artifact** for this
closeout. PR `#129` proves a read-only viewer path using the production
`viewerGateway -> readReceiptById` seam with no-mock Chromium smoke. The smoke
also proves restrictive CSP/no-store behavior, primitive allowlisted rendering,
non-allowlisted metadata suppression and that injected script does not execute.

This satisfies the issue's `external/client trust artifact` requirement. It is
**not external interoperability evidence** and is not described as such.

### 5. Targeted tests — PASS

Recorded targeted evidence includes:

- V4-B1 exact-identifier and real-server/SQLite inspector coverage;
- V4-B2B: `10` cases PASS;
- V4-B2A: `5/5` PASS;
- V4-B2 server coverage: `83/83` PASS;
- V4-B3 export: `36` PASS;
- B3 route auth: `11` PASS;
- receipt materialization: `8` PASS;
- reachability: `13` PASS;
- B3A bounded source: `20` PASS; and
- V4-B4 viewer contract/security/browser smoke recorded PASS.

### 6. Full suite — PASS

The controlling runtime head for the final V4 runtime change is PR `#588`:

```text
head: 5452a7680a2b3e96e5a288c928c64669cbe57cc9
Benchmark Regression: 31285073318 SUCCESS
Node 20 job:          93172327986 SUCCESS
Node 22 job:          93172328153 SUCCESS
Docker build:         93172454650 SUCCESS
```

Both Node jobs ran the full `npm test` runtime/test step successfully. The
post-merge source snapshot changes only V5 documentation, so no V4 runtime,
test or package byte changed after this exact runtime head.

A local B3 run that lacked `pdfkit` is recorded as environment-specific and is
not substituted for the exact-head CI result.

### 7. CI — PASS

Exact PR `#588` head:

```text
Security Checks:      31285073352 SUCCESS
Architecture Checks:  31285073314 SUCCESS
Benchmark Regression: 31285073318 SUCCESS
```

The B2 hardened security attestation remains separately recorded because its
own implementation PR was created before the fail-hard security workflow:

```text
Security Checks: 31186846627 SUCCESS
head: b6bfd7cce2d8ca0753e75b02ffa7ca5c6b368bce
```

### 8. Release / package smoke — PASS

This closeout uses package-install smoke, not a registry-publish claim.

`test/kernel-facade-contract.test.js` is part of the full `npm test` suite and
constructs a real tarball/consumer boundary. It:

1. runs `npm pack --json --ignore-scripts`;
2. creates a clean temporary consumer project;
3. installs the produced tarball through npm;
4. requires `huqan` and retained deep imports from the installed package;
5. runs installed CLI `--help`;
6. resolves packaged `better-sqlite3`; and
7. requires the installed server with auto-listen disabled.

That test belongs to the exact PR `#588` runtime tree whose full `npm test`
passed on Node 20 and Node 22. Separately, B3 recorded
`npm pack --dry-run --json --ignore-scripts` PASS with `196` files.

Therefore the **installable package/release smoke** requirement passes. No npm
registry publication, tag, deployment or external distribution is inferred.

### 9. Limitations / non-claims — PASS

This closeout does not claim any of the following:

- universal `V4 stable/complete` product maturity beyond this bounded Workbench
  runtime-evidence phase;
- external A2A/shared-trust interoperability;
- production V5 connector enforcement;
- public-safe/redacted receipt exchange;
- GitHub App / Streaming Trust production readiness;
- Certified Node, TrustBench, public badge, reputation economy or marketplace;
- ATP-to-HTP migration;
- non-default HTTP workspace authority;
- registry publication or deployment from package smoke; or
- local tests as proof of external interoperability.

The V4-B3 receipt bundle remains an internal/full trust artifact. Public-safe
exchange belongs to its later V5 gate.

### 10. Canonical source identity and closeout decision — PASS

Audit base:

```text
0a1cc37011679e138e55a79ec47e2ebbd7503c14
```

This branch is created directly from that exact `main`. The final merge SHA is
recorded by GitHub/Notion after merge rather than guessed inside a pre-merge
artifact.

Closeout verdict:

```text
V4_B5_SOURCE_TEST_CI_RELEASE_CLOSEOUT: PASS
```

## Consequence for V5

Closing V4-B5 removes the V4-closeout blocker from ADR-010, but it does **not**
turn V5 entry into PASS.

The controlling V5 decision remains:

```text
V5_IMPLEMENTATION_ENTRY: FAIL
```

because the independent external interoperability/conformance dependency is
still unproven under issue `#277` (`V5-C5`). A real external consumer/verifier
smoke, including invalid/tampered fail-closed cases, is still required before a
successor V5 entry audit may record PASS.

## Environment / evidence limits

Connector execution can verify repository source, exact Git identity, GitHub CI
and Notion records. It cannot truthfully claim a local worktree bootstrap,
`node scripts/agent-context.js`, local Graphify regeneration or an additional
local full-suite run in this environment. Those are not substituted with prose.

The closeout rests on the exact, already-green runtime CI and package smoke
above plus the proof that later source changes are documentation-only.
