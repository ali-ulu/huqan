# V5-D4 external conformance closeout

This closeout is bounded to the repository-owned installed-package consumer run. It does not
establish third-party verification, interoperability, production readiness, connector
certification, or security/compliance certification.

## Acceptance mapping

| Requirement | Executed boundary |
| --- | --- |
| Real external consumer | `npm pack`, installation in an OS temporary directory, then execution using only Node builtins and the installed `huqan` package |
| Valid fixtures pass | ATP examples, valid receipt bundles, canonical HTP 0.2 schemas, and the Shared Trust Package |
| Invalid, missing, expired, and tampered inputs fail closed | ATP negative objects, malformed and tampered bundles, and structural plus semantic C3 negatives |
| Replayed input fails closed | the installed `external-client-authority` accepts a signed ATP package once, then returns `EXTERNAL_CLIENT_AUTHORITY_REPLAY_DETECTED` for the identical package |
| ATP/HTP compatibility | legacy ATP 0.1 and canonical HTP 0.2 verifiers run against the same installed-package consumer report |

The replay case uses the authority's public snapshot/enforcement seam, a Node stdlib Ed25519
keypair, and an in-memory atomic reservation owner. The consumer imports no repository or test
helper. A mutation test bypasses duplicate reservation and requires the consumer run to fail,
preventing a decorative replay PASS.

## Reproduction and immutable evidence

Run from the exact Git head under review:

```text
npm run conformance:external -- --json
node --test test/v5-c5-external-conformance.test.js
node --test lib/external-client-authority.test.js
```

The pull request evidence record must include the exact head SHA, operating system, Node/npm and
Python versions, package version, commands, exit statuses, and unedited JSON report. CI checks must
be attached to that same head. The commit cannot truthfully embed its own SHA, so a SHA written only
inside this file is not accepted as exact-head evidence.

Historical implementation lineage:

- PR 620 merge `f9b1169e0ae01278d99b37ecb7573c0926a9910e` introduced the external runner with explicit blocked gaps.
- PR 624 merge `60eae4facf14d7cd93a7a770c6550d6be2d0693a` replaced those gaps with real installed-package cases and produced a 60-case report.

Issue D4 is complete only when the new replay case is present and the pull request records a green,
exact-head report with zero failures, zero skips, and `blockedGaps: []`.
