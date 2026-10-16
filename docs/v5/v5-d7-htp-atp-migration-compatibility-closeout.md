# V5-D7 HTP/ATP migration compatibility closeout

**Status:** `closeout`

## Decision

`V5_D7_HTP_ATP_MIGRATION_COMPATIBILITY: PASS`

This closeout is evaluated from `main @
13cc50b26cf0b78eb0c01bf959926c2facb69bef`. It applies the accepted
RFC-001 decision: HTP is the abbreviation of HUQAN Trust Protocol, not a
successor wire protocol to ATP. Compatibility therefore means preserving ATP
0.1 receipts and AXIOM package artifacts while canonical writers use the HUQAN
publication and package identities. It does not mean relabeling or rehashing
historical artifacts.

## Acceptance matrix

| D7 requirement | Result | Controlling evidence |
| --- | --- | --- |
| ATP receipts remain valid | PASS | The retained ATP object and bundle fixtures validate; the Receipt Trust Root migration suite preserves historical V1 bytes, hashes, chain linkage and bundle bytes. |
| ATP `.axiom` packages remain valid | PASS | The dual-format reader accepts all four retained AXIOM package 0.1 fixtures, including the trust-receipt bundle package. |
| HTP draft objects follow an explicit migration rule | PASS | RFC-001 forbids an ATP-to-HTP object rewrite. HTP 0.2 is the canonical publication lineage; M4 changes only the package envelope and leaves embedded portable objects on `protocolVersion: "0.1"`. |
| No breaking rename or schema rewrite | PASS | Readers accept the exact legacy and canonical tuples; the canonical writer emits only `huqan-package / 0.2 / protocolVersion 0.1`; mixed or crossed identities fail closed. Legacy spec, verifier and package paths remain shipped. |
| Cross-version valid and invalid fixtures pass | PASS | The installed-package conformance run accepts both package formats, converts a legacy package to canonical output, rejects mixed identity, and obtains identical findings from the legacy and canonical Python bundle verifiers for two valid and two invalid bundles. |

## Migration rule

The compatibility boundary is deliberately asymmetric:

- ATP 0.1 receipt and bundle schema versions are immutable and remain readable.
- AXIOM package 0.1 remains a valid input format.
- A canonical write creates a new HUQAN package 0.2 envelope; it does not
  mutate the supplied legacy package or rewrite an artifact in place.
- Embedded object semantics remain version `0.1`. Package format `0.2` is not
  a claim that the embedded protocol version is `0.2`.
- HTP 0.2 publishes the RFC-002-selected V5 JSON contracts and republishes the
  existing canonical receipt algorithm without redefining historical ATP
  bytes or hashes.
- Legacy and canonical discriminator fields cannot be combined. Ambiguous
  input is rejected rather than normalized by precedence.

## Immutable implementation lineage

M4 was merged by PR #635:

```text
base:  a7cfddd5596d8a0387c67b20564267ad74d22e4f
head:  b0f6fe960508eade7ed5f24e5ee4ffa8a75e7b38
merge: bdc1dada21e0d32517e25c229442185fee25b7af
tree:  6519d59c87d434f1a669815acdafeabdfbd25a76
```

The PR head and merge commit have the same tree. PR #635's exact-head checks
passed on Node 20 and Node 22, Docker, security and architecture. Its change
set did not alter the retained ATP 0.1 receipt/spec tree, AXIOM package 0.1
fixtures, or Receipt Trust Root historical fixtures.

PR #636 then produced current main `13cc50b26cf0b78eb0c01bf959926c2facb69bef`
and passed Node 20, Node 22, Docker, security and architecture. It implemented
D3 public-receipt exchange. Between #635 and current main it did not change the
legacy ATP/package trees, the M4 package reader/writer, the external conformance
consumer, or the Receipt Trust Root migration test.

## Reproduction evidence

Run from this closeout's exact Git head:

```text
node --test lib/atp-conformance.test.js lib/axiom-package-format.test.js test/receipt-trust-root-4-migration-compatibility.test.js
```

Result:

```text
tests 55
pass 55
fail 0
skipped 0
```

Run the installed tarball consumer:

```text
npm run conformance:external -- --json
```

Result:

```text
total 73
passed 73
failed 0
skipped 0
blockedGaps []
crossImplementationExecuted true
```

The cross-implementation case executes both shipped Python verifiers against
four receipt-bundle fixtures and requires identical findings. The package-wire
cases execute through an OS-temporary installation of the packed `huqan`
package rather than importing repository test helpers.

The legacy preservation check is:

```text
git diff --exit-code \
  a7cfddd5596d8a0387c67b20564267ad74d22e4f \
  b0f6fe960508eade7ed5f24e5ee4ffa8a75e7b38 -- \
  specs/axiom-trust-protocol/0.1 \
  specs/axiom-package-format/0.1 \
  test/fixtures/receipt-trust-root
```

Result: `PASS` with an empty diff.

## Nonclaims

- ATP was not renamed, converted or migrated to a new HTP wire protocol.
- Package format `0.2` does not imply embedded protocol version `0.2`.
- The repository-owned installed consumer is not third-party interoperability,
  production deployment, connector certification, or security/compliance
  certification.
- The evidence covers the retained compatibility fixtures and frozen legacy
  trees; it does not claim possession of every historical artifact created by
  external users.
- A file suffix or checksum is not identity, authenticity, or trust evidence.
- Legacy compatibility is a reader guarantee; canonical writers do not emit
  new `.axiom` artifacts.
