# V5-VERIFICATION-25A1 Resolver Binding Fixture Scope Amendment

## Purpose And Boundary

V25A1 defines a separate future fixture corpus for the V25A key-material
binding contract. This amendment is docs-only. It creates no fixture files,
resolver implementation, resolver test, adapter change, verification-core
change, schema, package, runtime, or MCP change.

The existing corpus remains unchanged:

```txt
test/fixtures/v5/trusted-key-resolver/
```

The future binding corpus is separate:

```txt
test/fixtures/v5/trusted-key-resolver-binding/
```

Exactly 20 future JSON fixtures are planned. V25A1 does not authorize V25A2,
fixture creation, or implementation.

## Canonical Existing Baseline

The current resolver input allowlist is:

```txt
keyReference
records
evaluationTime
```

The current record allowlist is:

```txt
keyReference
status
expiresAt
```

The six key states are:

```txt
active
unknown
revoked
expired
unavailable
malformed
```

Existing reason mappings remain exact:

```txt
unknown     -> unknown_key
revoked     -> revoked_key
expired     -> expired_key_metadata
unavailable -> key_lookup_unavailable
malformed   -> malformed_trusted_key_record
```

The exact existing malformed result remains:

```js
{
  keyState: "malformed",
  reasonCategory: "malformed_trusted_key_record"
}
```

Existing resolver validation validates the bounded root, timestamps,
forbidden content, every record, then match cardinality and lifecycle state.
The future binding corpus preserves this whole-record-before-selection order.
Therefore malformed public-key material in any record, including a
non-matching record, is a malformed-record result; no selected-record-only
semantics are invented.

## Runtime Versus Fixture Serialization

The runtime and fixture names are deliberately distinct:

| Layer | Field | Representation | Meaning |
| --- | --- | --- | --- |
| runtime resolver input record | `publicKeySpkiDer` | fresh `Buffer` or `Uint8Array` | bounded 44-byte public material |
| fixture input descriptor | `publicKeySpkiDer` | JSON descriptor | serialization-only instruction |
| fixture expected metadata | `publicKeySpkiDerHex` | strict lowercase hex string | test-only comparison value |

`publicKeySpkiDerHex` is never a runtime output field. A descriptor is never
passed directly to the resolver. The future consumer deep-copies fixture input,
materializes descriptors, and only then invokes the resolver.

## Serialization Contract

JSON fixtures may use exactly these descriptors at a runtime field named
`publicKeySpkiDer`:

```json
{
  "kind": "buffer-hex",
  "hex": "<strict-lowercase-even-length-hex>"
}
```

```json
{
  "kind": "uint8array-hex",
  "hex": "<strict-lowercase-even-length-hex>"
}
```

```json
{
  "kind": "raw-json",
  "value": null
}
```

Rules:

- `buffer-hex` materializes to a fresh Buffer;
- `uint8array-hex` materializes to a fresh Uint8Array;
- `raw-json` passes its value unchanged;
- absent `publicKeySpkiDer` remains absent;
- descriptors exist only in fixture serialization;
- descriptor keys are exact and unknown descriptor keys fail closed;
- lowercase, even-length hex is mandatory;
- uppercase hex, `0x`, whitespace, separators, base64 and alternate encodings
  are forbidden;
- visible byte length is checked after materialization;
- fixture input, descriptors and returned bytes are not mutated.

## Public-Key Sources And Limits

Only public material already present in the merged cryptographic fixture corpus
may be referenced:

```txt
test/fixtures/v5/cryptographic-adapter/01-valid-rfc8032-one-octet.json
caseId: valid-rfc8032-one-octet

test/fixtures/v5/cryptographic-adapter/04-invalid-different-ed25519-public-key.json
caseId: invalid-different-ed25519-public-key
```

The first supplies the RFC 8032 TEST 2 Ed25519 SPKI DER bytes. The second
supplies a distinct public-only Ed25519 SPKI DER value. No private key, seed,
signature-generation material or secret is copied.

The opaque case may derive a deterministic 44-byte invalid DER value from the
first public key by changing a documented byte such as DER tag `30` to `31`.
The resolver binding fixture must not claim cryptographic validity merely
because the bounded length is 44 bytes. DER import and Ed25519 enforcement
remain adapter responsibilities.

## Exact Future Corpus

The future directory contains exactly these 20 files and case IDs:

| # | Filename | Case ID | Expected result |
| --- | --- | --- | --- |
| 01 | `01-active-buffer-bound-key.json` | `01-active-buffer-bound-key` | active with requested `keyReference` and RFC public bytes |
| 02 | `02-active-uint8array-bound-key.json` | `02-active-uint8array-bound-key` | active with equivalent Uint8Array materialization |
| 03 | `03-active-opaque-44-byte-key.json` | `03-active-opaque-44-byte-key` | active bounded result; no crypto claim |
| 04 | `04-active-missing-key.json` | `04-active-missing-key` | `malformed/malformed_trusted_key_record` |
| 05 | `05-active-null-key.json` | `05-active-null-key` | `malformed/malformed_trusted_key_record` |
| 06 | `06-active-string-key.json` | `06-active-string-key` | `malformed/malformed_trusted_key_record` |
| 07 | `07-active-key-one-byte-short.json` | `07-active-key-one-byte-short` | `malformed/malformed_trusted_key_record` |
| 08 | `08-active-key-one-byte-long.json` | `08-active-key-one-byte-long` | `malformed/malformed_trusted_key_record` |
| 09 | `09-revoked-without-key.json` | `09-revoked-without-key` | existing `revoked/revoked_key` shape |
| 10 | `10-revoked-with-valid-key.json` | `10-revoked-with-valid-key` | existing `revoked/revoked_key` shape |
| 11 | `11-revoked-with-malformed-present-key.json` | `11-revoked-with-malformed-present-key` | `malformed/malformed_trusted_key_record` under whole-record validation |
| 12 | `12-expired-with-valid-key.json` | `12-expired-with-valid-key` | existing `expired/expired_key_metadata` shape |
| 13 | `13-unavailable-with-valid-key.json` | `13-unavailable-with-valid-key` | existing `unavailable/key_lookup_unavailable` shape |
| 14 | `14-unknown-empty-records.json` | `14-unknown-empty-records` | existing `unknown/unknown_key` shape |
| 15 | `15-unknown-reference-mismatch-same-key.json` | `15-unknown-reference-mismatch-same-key` | existing `unknown/unknown_key` shape |
| 16 | `16-ambiguous-duplicate-same-key.json` | `16-ambiguous-duplicate-same-key` | `malformed/malformed_trusted_key_record` |
| 17 | `17-ambiguous-duplicate-different-keys.json` | `17-ambiguous-duplicate-different-keys` | `malformed/malformed_trusted_key_record` |
| 18 | `18-malformed-record-forbidden-public-key-field.json` | `18-malformed-record-forbidden-public-key-field` | `malformed/malformed_trusted_key_record` |
| 19 | `19-malformed-root-parallel-public-key.json` | `19-malformed-root-parallel-public-key` | existing malformed root result |
| 20 | `20-malformed-nonmatching-record-before-selection.json` | `20-malformed-nonmatching-record-before-selection` | `malformed/malformed_trusted_key_record` under whole-record validation |

Cases 11 and 20 are intentionally precedence sentinels. The current resolver
validates every record before selecting matches. The future binding contract
therefore treats malformed present public material in either record as
dominant. If a later implementation cannot preserve this deterministic
whole-record order, it must stop with:

```txt
V5-VERIFICATION-25A1_BLOCKED_BY_RECORD_VALIDATION_PRECEDENCE_GAP
```

No first-match, last-match, record merge, or selected-record-only fallback is
allowed.

## Envelope And Expected Shapes

Every future fixture has exactly:

```txt
caseId
description
input
expected
nonClaims
```

Input preserves the resolver root fields `keyReference`, `records`, and
`evaluationTime`, except case 19, which intentionally adds a root-level
`publicKeySpkiDer` and must fail closed.

Active expected metadata is fixture-only:

```json
{
  "keyState": "active",
  "keyReference": "<exact-requested-reference>",
  "publicKeySpkiDerHex": "<strict-lowercase-hex>"
}
```

Non-active expected objects reproduce the existing resolver state/reason
objects exactly and contain no key reference, public key bytes, record data,
provider metadata, network metadata, private material or free-form text.

## Future Consumer Invariants

The later fixture consumer must validate:

- exactly 20 files and unique filenames;
- unique case IDs and exact filename mapping;
- parseable JSON and exact envelope keys;
- exact descriptor keys and strict lowercase hex;
- exact post-materialization byte lengths;
- exact existing state/reason mappings;
- active keyReference equality and byte equality with
  `publicKeySpkiDerHex`;
- fresh returned bytes that do not alias input bytes;
- non-active key absence;
- duplicate and reference-mismatch behavior;
- whole-record precedence for cases 11 and 20;
- fixture immutability and deterministic materialization;
- absence of private or secret material.

## Future Gates And Non-Claims

The required sequence remains:

```txt
V25A1 fixture-scope amendment
-> V25A2 binding fixture corpus
-> V25A3 binding fixture-contract tests
-> V25A4 resolver binding implementation taskpack
-> V25A5 resolver binding implementation
-> V25A6 resolver binding adversarial hardening
-> signed-content binding recovery
-> composition-scope retry
```

V25A1 does not change the existing 12 fixtures and does not authorize source
implementation.

Permanent non-claims:

- no resolver implementation change;
- no cryptographic validation by the resolver;
- no live key store or network/database lookup;
- no private key, seed, key generation, or signing;
- no certificate-chain validation;
- no composition implementation;
- no trust or authorization decision;
- no A2A or connector enforcement;
- no V5-complete claim.

## Exit Criteria

V25A1 is complete only when this single amendment defines the separate future
directory, exact 20-case table, runtime-versus-fixture field distinction,
descriptor serialization, public-only provenance, active/non-active output
confinement, duplicate and reference-mismatch cases, whole-record precedence,
future A2/A3 boundaries, and permanent non-claims. No fixture, test, source or
package file belongs to this gate.

Next gate after closeout:

```txt
V5-VERIFICATION-25A2_RESOLVER_BINDING_FIXTURES
```
