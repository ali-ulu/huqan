# V5-VERIFICATION-21 Cryptographic Adapter Implementation Taskpack

## Future V22 Scope

V22 may change only:

```txt
lib/v5/cryptographic-verification-adapter.js
test/v5-cryptographic-verification-adapter.test.js
```

V21 is docs-only and does not create either file.

## Public API

The future module uses CommonJS and exports one synchronous named function:

```js
module.exports = {
  verifyCryptographicEvidence
};
```

`verifyCryptographicEvidence(input)` accepts exactly one plain object with own
enumerable data properties only. Its allowed and required keys are:

```txt
algorithm
messageBytes
publicKeySpkiDer
signatureBytes
```

It has no class, callback, promise, default export, resolver input, key-store
reference, or public dependency-injection parameter.

## Input And Output Contract

`algorithm` is the exact case-sensitive string `ed25519-v1`; aliases,
trimming, normalization, fallback, and `test-structural-v1` are unsupported.

`messageBytes`, `publicKeySpkiDer`, and `signatureBytes` accept only
`Buffer` or `Uint8Array`. The adapter copies the exact
`byteOffset`/`byteLength` range before crypto use and never mutates or
returns caller-owned bytes.

The only outputs are:

```js
{ cryptographicState: 'valid' }
{ cryptographicState: 'invalid', reasonCategory: 'signature_invalid' }
{ cryptographicState: 'malformed', reasonCategory: 'input_malformed' }
{ cryptographicState: 'malformed', reasonCategory: 'message_malformed' }
{ cryptographicState: 'malformed', reasonCategory: 'public_key_malformed' }
{ cryptographicState: 'malformed', reasonCategory: 'signature_malformed' }
{ cryptographicState: 'unsupported', reasonCategory: 'algorithm_unsupported' }
```

Each result is fresh, contains no undefined fields, explanation, exception,
stack, byte echo, trust, or authorization output.

## Deterministic Validation Order

Earlier failures dominate later checks:

1. Non-plain root, null, primitive, array, Date, RegExp, inherited property,
   own symbol, getter/setter, missing key, or unknown key:
   `malformed/input_malformed`.
2. Non-string algorithm: `malformed/input_malformed`.
3. Algorithm other than exact `ed25519-v1`:
   `unsupported/algorithm_unsupported`.
4. Invalid message type, empty value, or length outside 1..1048576:
   `malformed/message_malformed`.
5. Invalid public-key type, non-44-byte value, forbidden material, DER/SPKI
   import failure, or imported non-Ed25519 key:
   `malformed/public_key_malformed`.
6. Invalid signature type or non-64-byte value:
   `malformed/signature_malformed`.
7. Invoke `crypto.verify` only after all prior checks succeed.
8. `true` returns `valid`; `false` returns
   `invalid/signature_invalid`; a post-validation exception returns
   `malformed/input_malformed` without leakage.

## Crypto Operation

V22 uses Node built-in `node:crypto` only:

```js
const keyObject = crypto.createPublicKey({
  key: copiedPublicKeyBytes,
  format: 'der',
  type: 'spki'
});
if (keyObject.asymmetricKeyType !== 'ed25519') {
  return malformedPublicKey();
}
const verified = crypto.verify(
  null,
  copiedMessageBytes,
  keyObject,
  copiedSignatureBytes
);
```

There is no hash/digest mode, signing, key generation, PEM/JWK/raw-key
fallback, certificate chain, resolver, network, database, filesystem write, or
shared mutable cache.

## Fixture Mapping

V22 consumes every merged fixture exactly once after strict lowercase-hex
decoding in test code. It passes `Buffer` values to the adapter, never fixture
strings.

- Cases 01: `valid`.
- Cases 02, 03, 04, and 14: reach `crypto.verify`, return `false`, and map
  to `invalid/signature_invalid`.
- Cases 05 and 06: `unsupported/algorithm_unsupported`.
- Case 07: `malformed/message_malformed`.
- Cases 08, 09, and 10: `malformed/public_key_malformed`.
- Cases 11, 12, and 13: `malformed/signature_malformed`.
- Cases 15, 16, and 17: `malformed/input_malformed`.

Case 08 must prove the valid parent SPKI has zero-based byte 43 equal to
`0c`, the fixture key is 43 bytes, structural rejection occurs before
`crypto.verify`, and the exact result is
`malformed/public_key_malformed`.

## Mandatory V22 Tests

The single V22 test file must cover exact export, every fixture, root and field
confinement, algorithm policy, message/key/signature types and bounds, RFC 8032
TEST 2 verification, four invalid vectors, all exact output objects, case 08,
input immutability, Buffer/Uint8Array parity and offset views, repeated
determinism, no clock/random/network/database use, and
`normalizeCryptographicVerificationEvidence` shape compatibility only.

It must force a post-validation `crypto.verify` exception using Node's
repository-supported test mocking without adding a public API parameter or
dependency. That case must return exactly
`malformed/input_malformed`, not throw, leak no details, and leave buffers
unchanged.

V22 must run:

```bash
node --test test/v5-cryptographic-verification-adapter.test.js
node --test test/v5-cryptographic-profile-contract.test.js test/v5-cryptographic-adapter-fixtures.test.js test/v5-cryptographic-verification-adapter.test.js test/v5-verification-core.test.js
npm test
git diff --check main...HEAD
git diff --name-only main...HEAD
git status --short
```

## Non-Claims

V22 does not add key resolution, key store, certificate-chain validation, key
generation, signing, receipt signing, network/database provider, resolver
composition, package trust, authorization, A2A, connector enforcement, or a
V5-complete claim.

