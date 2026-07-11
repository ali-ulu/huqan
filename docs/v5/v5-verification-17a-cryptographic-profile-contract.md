# V5-VERIFICATION-17A - Cryptographic Profile Contract

Mode: source-level profile and canonical byte contract
Base: main @ 25b18e2b89d926bfb8f79131630cb61dd669302d

## Purpose

V17A closes the source-contract gaps that blocked the cryptographic adapter
scope. It defines canonical message bytes and the future adapter profile. It
does not perform signature verification or modify verification-core, resolver,
fixtures, packages, or runtime surfaces.

## Canonical Signed Content

Future cryptographic verification consumes canonical message bytes only. It
does not accept a caller-supplied digest mode.

Canonical JSON bytes are produced by:

    encodeJsonStableV1(value)

The canonicalizer returns a UTF-8 Buffer and owns application-object
serialization. A future adapter receives bytes only and must not stringify,
reorder, coerce, or canonicalize application values.

json-stable-v1 accepts null, booleans, finite numbers, strings, dense arrays,
plain objects, and safely enumerable null-prototype objects. It rejects
undefined, function, symbol, bigint, non-finite numbers, Date, RegExp, Map,
Set, Buffer, Uint8Array, sparse arrays, cycles, accessors, symbol properties,
inherited enumerable state, custom toJSON behavior, and non-plain objects.

Object keys are own enumerable string keys sorted with JavaScript UTF-16
code-unit lexical ordering. JSON primitive escaping applies. Negative zero
encodes as numeric zero. Output has no BOM or trailing newline.

## Future Cryptographic Profile

CRYPTOGRAPHIC_PROFILE_V1 pins:

- profile identifier: ed25519-v1
- signed-content mode: canonical-message-bytes
- canonicalization: json-stable-v1
- text encoding: utf-8
- future runtime primitive: node:crypto
- messageBytes: Buffer or Uint8Array, 1 through 1,048,576 bytes
- publicKeySpkiDer: Ed25519 SPKI DER, Buffer or Uint8Array, exactly 44 bytes
- signatureBytes: raw Ed25519 signature, Buffer or Uint8Array, exactly 64 bytes

The only future adapter input keys are:

    algorithm
    messageBytes
    publicKeySpkiDer
    signatureBytes

The algorithm identifier is exact lowercase ed25519-v1. It is case-sensitive,
has no alias, and has no fallback. test-structural-v1 remains synthetic and is
not a real cryptographic profile.

PEM, JWK, raw 32-byte keys, certificates, KeyObject inputs, private keys,
shared secrets, provider references, network locations, database identifiers,
implicit key resolution, string encodings, and alternate decoders are outside
this profile.

## Future Adapter Result Contract

A later adapter may return only:

    { cryptographicState: "valid" }

    { cryptographicState: "invalid", reasonCategory: "signature_invalid" }

    { cryptographicState: "malformed", reasonCategory:
      "input_malformed" | "message_malformed" |
      "public_key_malformed" | "signature_malformed" }

    { cryptographicState: "unsupported",
      reasonCategory: "algorithm_unsupported" }

No other state, reason, byte echo, exception text, stack trace, trust score,
authorization result, provider metadata, or free-form explanation is allowed.

## Layer Separation

- The trusted-key resolver classifies supplied key state and does not verify
  signatures.
- A future cryptographic adapter verifies supplied bytes and supplied public
  verification material. It performs no lookup or trust decision.
- The verification core remains responsible for its current bounded reasoning.
- A future composition gate, not V17A, may connect these bounded layers.
- Authorization and policy remain outside this profile.

## Non-Claims

V17A does not create crypto.verify behavior, real signature verification,
key resolution, key storage, certificate validation, key generation, rotation,
revocation service, network/database provider, package trust, authorization,
receipt signing, A2A, connector enforcement, or V5 completion.

## Exit Criteria

Only these files may change:

    docs/v5/v5-verification-17a-cryptographic-profile-contract.md
    lib/v5/cryptographic-profile-contract.js
    test/v5-cryptographic-profile-contract.test.js

No dependency is added. node:crypto is only a future runtime authorization and
is not invoked by this gate.
