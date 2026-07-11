# V5-VERIFICATION-17 Cryptographic Adapter Scope Definition

## Purpose

This document authorizes a future, narrowly bounded cryptographic adapter
implementation. This gate is docs-only: it does not create the adapter, invoke
crypto, resolve keys, compose verification layers, or claim a verified package.

## Canonical Profile

The future adapter accepts only the V17A cryptographic profile:

- algorithm: exact, case-sensitive `ed25519-v1`
- signed content: canonical message bytes
- canonicalizer: `encodeJsonStableV1`
- text encoding: UTF-8
- message length: 1 through 1,048,576 bytes
- public key: Ed25519 SPKI DER, exactly 44 bytes
- signature: raw Ed25519 signature, exactly 64 bytes
- future primitive: Node built-in `node:crypto`

The adapter accepts a plain bounded input with exactly these keys:

```txt
algorithm
messageBytes
publicKeySpkiDer
signatureBytes
```

It must not accept PEM, JWK, raw keys, certificates, KeyObject values, private
keys, strings, alternate encodings, digest modes, aliases, fallback algorithms,
or caller-supplied canonicalization.

## Future Adapter Result

The future adapter may return only these V17A results:

```txt
{ cryptographicState: "valid" }
{ cryptographicState: "invalid", reasonCategory: "signature_invalid" }
{ cryptographicState: "malformed", reasonCategory: "input_malformed" }
{ cryptographicState: "malformed", reasonCategory: "message_malformed" }
{ cryptographicState: "malformed", reasonCategory: "public_key_malformed" }
{ cryptographicState: "malformed", reasonCategory: "signature_malformed" }
{ cryptographicState: "unsupported", reasonCategory: "algorithm_unsupported" }
```

The adapter fails closed and does not expose exceptions, byte values, stack
traces, provider metadata, trust, authorization, or free-form explanations.
`normalizeCryptographicVerificationEvidence` is the separate V17B handoff
boundary that validates these results before any later composition gate.

## Layer Separation

The trusted-key resolver owns key lookup and key-state classification. The
future adapter receives already supplied public verification material and does
not resolve references, use a key store, access a network or database, or make
trust and authorization decisions. The verification core handoff validates
result shape only. Layer composition is a later, separately scoped gate.

`test-structural-v1` remains synthetic. It is not an `ed25519-v1` fallback and
must not be replaced by this future adapter.

## Future Implementation Boundary

Only a later implementation gate may create these planned files:

```txt
lib/v5/cryptographic-verification-adapter.js
test/v5-cryptographic-verification-adapter.test.js
```

That later gate may call the Node built-in exactly as follows after all bounded
input checks pass:

```js
crypto.verify(
  null,
  messageBytes,
  {
    key: publicKeySpkiDer,
    format: 'der',
    type: 'spki'
  },
  signatureBytes
)
```

It must use no digest mode, fallback, PEM/JWK/raw-key decoding, key resolution,
network access, persistence, package trust decision, or authorization decision.

## Non-Claims

This scope definition does not add real crypto, signature verification, key
management, certificate validation, runtime exchange, transport, persistence,
A2A, connector enforcement, marketplace behavior, AgentAction policy behavior,
or a V5-complete claim.
