# V5-D2 external package verification closeout

**Status:** `closeout`

## Decision

V5-D2 is satisfied on the audited repository base:

```text
base: 648807c2990f1085fdc35d3d08d36ded8fec0b21
external-client integration PR: #625
external-client integration head: 725694321a4a8978723e6c4e044ba9e14039a835
external-client integration merge: fd51a63a2d17d41d90e76d71d3d7cfaef5ea165d
```

No additional runtime implementation is justified. The existing package gate,
SDK boundary, and standalone client smoke already exercise the required
behavior. This document records the source and executable evidence without
expanding that boundary.

## Acceptance evidence

| D2 criterion | Current evidence | Result |
| --- | --- | --- |
| A package arriving across the repository boundary can be verified | `scripts/external-client.js` is a Node.js standard-library-only client with no repository-internal imports. `test/external-client-standalone.test.js` sends the serialized signed envelope over real loopback HTTP. | `PASS` |
| Signature, key, and package bindings are checked | `lib/external-client-package-gate.js` canonicalizes the package, verifies its Ed25519 signature, resolves only a trusted public key, and binds the key scope to identity kind, identity subject, workspace, and package ID. Package manifest workspace, creator, and package ID must match server-owned authority. | `PASS` |
| Tampered or invalid packages fail closed | `lib/external-client-package-gate.test.js`, `lib/sdk-external-package.test.js`, and `test/external-client-standalone.test.js` reject invalid format, validator warnings, unsupported algorithms, unknown or wrong keys, scope mismatches, post-signature package changes, workspace changes, and identity changes. Rejections do not reach the admission handler and do not create candidate, journal, or receipt rows. | `PASS` |
| The external smoke is reproducible | The command and observed result below cover the package gate, SDK admission boundary, and standalone HTTP client. | `PASS` |

The standalone verifier also recomputes the package hash and chained receipt
hash. Its adversarial cases reject ordinary receipt mutations and attacker-
rehashed changes to actor, workspace, operation, candidate, decision, verdict,
and status bindings.

## Reproducible smoke

Run from the repository root at the audited base:

```text
node --test lib/external-client-package-gate.test.js lib/sdk-external-package.test.js test/external-client-standalone.test.js
```

Observed result:

```text
tests: 37
pass: 37
fail: 0
skipped: 0
```

This command intentionally names the behavioral D2 surface. A broader local
run that also included `lib/external-client-http-adapter.test.js` and
`test/external-client-route-adversarial.test.js` produced 63 passes and two
Windows process-environment failures:

```text
spawnSync npm ENOENT
spawnSync npm.cmd EINVAL
```

Both failures occurred in package-boundary `npm pack --dry-run` assertions, not
in package verification, signature rejection, HTTP admission, or mutation
checks. They are disclosed as local environment outcomes and are not counted as
passing evidence.

## Exact-head CI reconciliation

PR `#625` introduced the standalone external-client proof. Its exact head
`725694321a4a8978723e6c4e044ba9e14039a835` passed:

```text
Security Checks:                 PASS
Architecture / acyclic graph:    PASS
Benchmark:                       PASS
Docker build:                    PASS
npm test, Node 20:               PASS (8m53s)
npm test, Node 22:               PASS (2m11s)
```

The current-base smoke above independently confirms the D2 behavioral surface
after the subsequent merged work.

## Boundary and nonclaims

The package crosses a serialized HTTP boundary and the proof client imports no
HUQAN implementation. It remains repository-owned evidence. This closeout does
not claim:

- unrelated third-party implementation, adoption, or interoperability;
- a registered production external-package HTTP route;
- remote deployment, external service uptime, or production key provisioning;
- universal package trust or verification of arbitrary package formats;
- general SDK support beyond the tested admission surface;
- Certified Node, TrustBench, legal, compliance, or security certification;
- ecosystem, marketplace, or industry-standard readiness; or
- that passing tests prove behavior outside the tested identity, workspace,
  package, signature, admission, and receipt boundaries.

## Closeout

The C5/C6 blocker is satisfied. The required verification boundary exists,
tamper paths fail closed, the smoke is reproducible, and no new D2 runtime code
is necessary.

```text
V5_D2_EXTERNAL_PACKAGE_VERIFICATION: PASS
```
