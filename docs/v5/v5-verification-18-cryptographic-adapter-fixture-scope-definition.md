# V5-VERIFICATION-18 Cryptographic Adapter Fixture Scope Definition

## Purpose

V18 defines the static serialized fixture contract for a future V5 cryptographic
verification adapter. It is docs-only. It adds no fixture JSON, adapter, adapter
test, `crypto.verify` invocation, dependency, or verification-core change.

The planned directory is `test/fixtures/v5/cryptographic-adapter/`; it is a
planning reference only and must not be created by V18.

## Canonical Profile

Future fixture inputs describe only the V17A profile:

- exact algorithm `ed25519-v1`
- signed content is message bytes
- `encodeJsonStableV1` remains the upstream canonicalizer boundary
- runtime input remains `Buffer` or `Uint8Array`, never a fixture string
- public key is Ed25519 SPKI DER and exactly 44 bytes
- signature is raw Ed25519 and exactly 64 bytes
- message length is 1 through 1,048,576 bytes
- the future runtime primitive is Node built-in `node:crypto`

There is no digest-input mode, PEM, JWK, raw-key, algorithm, or encoding
fallback. Fixture serialization never changes the future runtime byte API.

## Fixture Serialization

JSON fixtures use lowercase hexadecimal only. The serialized input field names
are deliberately distinct from runtime byte fields:

```txt
messageBytesHex
publicKeySpkiDerHex
signatureBytesHex
```

Each hex value is ASCII lowercase, has an even character count, has no `0x`
prefix, whitespace, separator, mixed case, or alternate base64 form. Future
contract tests must reject permissive decoding and prove decoding reproduces
the exact intended bytes. Malformed fixture hex is a fixture-contract failure,
not an adapter result; committed fixture JSON must remain parseable.

## Exact Envelope

Every future fixture has these required root keys:

```txt
caseId
description
input
expected
nonClaims
```

Only the authoritative valid known-answer fixture additionally requires
`provenance`. Unknown root keys are rejected by future fixture contract tests.
`nonClaims` is required because existing V5 verification fixtures use it, and
its exact ordered values are:

```txt
package_trust_not_established
action_authorization_not_established
identity_verification_not_established
external_exchange_not_established
production_crypto_not_claimed
```

`input` permits only `algorithm`, `messageBytesHex`, `publicKeySpkiDerHex`,
and `signatureBytesHex`. Every case that represents a complete adapter input
has all four. The three confinement cases deliberately omit or add a field as
specified in the corpus table. Unknown input keys are fail-closed
`input_malformed` cases.

`expected` permits only `cryptographicState` and optional `reasonCategory`.
The exact allowed pairs are:

```txt
valid                         -> { cryptographicState: "valid" }
invalid                       -> { cryptographicState: "invalid", reasonCategory: "signature_invalid" }
malformed                     -> { cryptographicState: "malformed", reasonCategory: "input_malformed" | "message_malformed" | "public_key_malformed" | "signature_malformed" }
unsupported                   -> { cryptographicState: "unsupported", reasonCategory: "algorithm_unsupported" }
```

Filenames are ordered two-digit lowercase kebab-case JSON names such as
`01-valid-rfc8032-one-octet.json`. `caseId` is lowercase kebab-case, unique,
and semantically matches its filename without the numeric prefix.

## Authoritative Known-Answer Vector

The valid case must use RFC 8032, *Edwards-Curve Digital Signature Algorithm
(EdDSA)*, section 7.1, test vector `TEST 2` (one-octet message, `0x72`). It is
a stable primary specification vector with a non-empty message.

Its fixture must record `provenance` with source title, section/vector ID, the
exact source message bytes, public key, signature, and the deterministic SPKI
DER transformation. The 44-byte Ed25519 SPKI DER is the fixed 12-byte DER
prefix `302a300506032b6570032100` followed by the vector's 32-byte public key.
No private key or seed is committed. If the vector cannot meet this exact
V17A profile, stop with `V5-VERIFICATION-18_BLOCKED_BY_VECTOR_PROFILE_MISMATCH`.

## Exact Corpus: 17 Fixtures

| # | Filename and caseId | Class | Expected result | Deterministic source or mutation |
| --- | --- | --- | --- | --- |
| 01 | `01-valid-rfc8032-one-octet.json` / `valid-rfc8032-one-octet` | authoritative valid | `valid` | RFC 8032 section 7.1 TEST 2 |
| 02 | `02-invalid-message-byte-mutation.json` / `invalid-message-byte-mutation` | structurally valid, invalid signature | `invalid/signature_invalid` | parent 01; message byte 0 changes `72` to `73` |
| 03 | `03-invalid-signature-byte-mutation.json` / `invalid-signature-byte-mutation` | structurally valid, invalid signature | `invalid/signature_invalid` | parent 01; signature byte 0 changes `92` to `93` |
| 04 | `04-invalid-different-ed25519-public-key.json` / `invalid-different-ed25519-public-key` | structurally valid, invalid signature | `invalid/signature_invalid` | RFC 8032 section 7.1 TEST 3 public key, transformed with the fixed SPKI DER prefix |
| 05 | `05-unsupported-algorithm.json` / `unsupported-algorithm` | unsupported algorithm | `unsupported/algorithm_unsupported` | exact `ed25519-v2` identifier |
| 06 | `06-unsupported-algorithm-case-variant.json` / `unsupported-algorithm-case-variant` | unsupported algorithm | `unsupported/algorithm_unsupported` | exact `Ed25519-v1` case variant |
| 07 | `07-malformed-empty-message.json` / `malformed-empty-message` | message failure | `malformed/message_malformed` | empty lowercase hex |
| 08 | `08-malformed-public-key-one-byte-short.json` / `malformed-public-key-one-byte-short` | public-key failure | `malformed/public_key_malformed` | parent 01 public key byte 43 `60` removed |
| 09 | `09-malformed-public-key-one-byte-long.json` / `malformed-public-key-one-byte-long` | public-key failure | `malformed/public_key_malformed` | parent 01 public key with one recorded `00` byte appended |
| 10 | `10-malformed-public-key-invalid-spki.json` / `malformed-public-key-invalid-spki` | public-key failure | `malformed/public_key_malformed` | parent 01 SPKI DER byte 0 changes `30` to `31`, preserving length 44 |
| 11 | `11-malformed-signature-one-byte-short.json` / `malformed-signature-one-byte-short` | signature failure | `malformed/signature_malformed` | parent 01 signature byte 63 `00` removed |
| 12 | `12-malformed-signature-one-byte-long.json` / `malformed-signature-one-byte-long` | signature failure | `malformed/signature_malformed` | parent 01 signature with one recorded `00` byte appended |
| 13 | `13-malformed-empty-signature.json` / `malformed-empty-signature` | signature failure | `malformed/signature_malformed` | empty lowercase hex |
| 14 | `14-invalid-wrong-64-byte-signature.json` / `invalid-wrong-64-byte-signature` | structurally valid, invalid signature | `invalid/signature_invalid` | parent 01; signature byte 63 changes `00` to `01` |
| 15 | `15-malformed-missing-signature-field.json` / `malformed-missing-signature-field` | input confinement | `malformed/input_malformed` | omits required `signatureBytesHex` |
| 16 | `16-malformed-unknown-root-field.json` / `malformed-unknown-root-field` | root confinement | `malformed/input_malformed` | adds one unknown root field `unexpected` |
| 17 | `17-malformed-forbidden-input-material.json` / `malformed-forbidden-input-material` | input confinement | `malformed/input_malformed` | adds forbidden input field `privateKeyHex` |

The table is the mutation record: every mutation names its parent, exact byte
index, and deterministic replacement rule. The resulting fixture remains
self-contained and contains all required bytes. A valid DER/SPKI key of a
different algorithm is intentionally excluded because it would widen the
Ed25519-only profile. Oversized-message behavior belongs to a later synthetic
unit test and no fixture may exceed 1,048,576 bytes.

## Structural And Cryptographic Separation

Malformed means wrong field type, missing or unknown field, forbidden material,
bad byte length, or invalid Ed25519 SPKI DER. `signature_invalid` is reserved
for a complete structurally valid Ed25519 SPKI key, an exact 64-byte signature,
and a primitive verification result of `false`. A crypto exception is not
automatically valid or invalid; the later adapter maps it only through the
bounded malformed contract. Public-key import failures never become
`signature_invalid`.

## Fixture Independence And Secret Boundary

Each fixture is self-contained and has no dependency on another fixture,
environment variable, locale, timezone, filesystem path, network, database,
key store, cache, current time, or runtime-generated key. Parent references in
the table are documentary only.

Fixtures contain no private key, seed, symmetric secret, credential, token,
password, provider configuration, endpoint, key-store handle, certificate
private material, PEM file, binary blob, generated archive, or derivation
script. Public test-vector keys and signatures are allowed public material.

## Future Contract Tests

A later test-only gate must assert the exact count `17`, JSON parseability,
unique filename and `caseId`, root/input/expected key confinement, strict
lowercase hex, even hex length, exact decoded byte sizes, state/reason pairs,
valid-vector provenance, absence of secret material, required class coverage,
and consistency of each table mutation declaration. It must not generate keys
or call the runtime adapter merely to validate fixture shape.

Future adapter tests may strictly decode fixture hex into `Buffer` values and
call the byte API. They must never pass fixture strings directly to the adapter
and must assert exact result objects.

## V17B Core Boundary

Fixtures define only adapter results before
`normalizeCryptographicVerificationEvidence`. They do not define final
verification-core precedence, trusted-key resolver composition, package trust,
authorization, key-state decisions, receipt signing, transport, or exchange.

## Future Sequence

```txt
V18 fixture scope
-> V19 fixture corpus
-> V20 fixture contract tests
-> V21 adapter implementation taskpack
-> V22 adapter implementation and tests
-> adversarial test scope
-> adversarial hardening
-> later resolver/core composition scope
```

This document does not authorize V19.

## Permanent Non-Claims

V18 does not add a crypto adapter, `crypto.verify` call, private keys, runtime
key generation, key resolution, key store, certificate-chain validation,
network or database provider, trust decision, authorization decision, receipt
signing, A2A, connector enforcement, or a V5-complete claim.
