# V5-VERIFICATION-25A Key Material Binding Contract

## Purpose And Boundary

V25A recovers the missing canonical binding between a requested
`keyReference`, the unique resolver-selected record, and the public key bytes
later supplied to the cryptographic adapter. This gate is docs-only. It adds no
resolver, adapter, verification-core, fixture, test, schema, package, runtime,
or MCP change.

The current gap is real: the resolver currently returns key state while the
adapter independently accepts `publicKeySpkiDer`. V25A defines the future
ownership contract that later resolver fixture and implementation gates must
make executable. It does not authorize those gates or composition.

## Existing Canonical Mapping

The current resolver implementation in
`lib/v5/trusted-key-resolver.js` uses this record allowlist:

```txt
keyReference
status
expiresAt
```

Its exact malformed result is:

```js
{
  keyState: "malformed",
  reasonCategory: "malformed_trusted_key_record"
}
```

Its non-active mappings remain:

```txt
unknown     -> { keyState: "unknown", reasonCategory: "unknown_key" }
revoked     -> { keyState: "revoked", reasonCategory: "revoked_key" }
expired     -> { keyState: "expired", reasonCategory: "expired_key_metadata" }
unavailable -> { keyState: "unavailable", reasonCategory: "key_lookup_unavailable" }
malformed   -> { keyState: "malformed", reasonCategory: "malformed_trusted_key_record" }
```

An active result currently has the exact shape `{ keyState: "active" }`. The
future binding contract below is not implemented by this gate.

## Sole Public-Key Owner

The unique resolver-selected record is the sole canonical owner of the public
verification key for its `keyReference`. The future record allowlist becomes:

```txt
keyReference
status
expiresAt
publicKeySpkiDer
```

Composition must construct the adapter input from the active resolver result.
It must not accept a separate caller-supplied `publicKeySpkiDer` alongside a
`keyReference`. Caller co-location is not a cryptographic or deterministic
binding.

No public-key fingerprint, digest, or equality substitute may replace resolver
ownership unless a later source-bound contract explicitly defines it.

## Public-Key Record Field

For the future resolver binding, `publicKeySpkiDer` is a runtime `Buffer` or
`Uint8Array` containing exactly 44 visible bytes. The bytes represent intended
Ed25519 SPKI DER material. The resolver is responsible only for bounded field
shape and defensive copying:

- accept Buffer or Uint8Array only;
- respect byteOffset and byteLength;
- require exactly 44 visible bytes;
- copy caller-owned bytes;
- never mutate the record, input bytes, or record array.

The resolver does not import DER, inspect the OID, enforce the Ed25519 key
type, call `node:crypto`, or verify signatures. Those responsibilities remain
with `lib/v5/cryptographic-verification-adapter.js`.

Forbidden representations remain:

```txt
PEM
JWK
raw 32-byte key
KeyObject
certificate
PKCS8/private key
provider reference
key-store handle
URL or endpoint
database identifier
```

## Record And State Rules

When `publicKeySpkiDer` is present, wrong type or wrong visible length produces
the existing exact malformed result:

```js
{
  keyState: "malformed",
  reasonCategory: "malformed_trusted_key_record"
}
```

For a uniquely selected record with `status: "active"`,
`publicKeySpkiDer` is mandatory. Missing, malformed, or forbidden material is
malformed and cannot produce an active result.

For `unknown`, `revoked`, `expired`, `unavailable`, or `malformed` records,
public-key material never rehabilitates the lifecycle state. The resolver
returns the existing non-active result shape and exposes no key bytes or
record contents.

The existing resolver evaluation order remains authoritative: root and record
shape, bounded identifiers and timestamps, forbidden content, record validity,
match cardinality, lifecycle state, and active expiry classification. Later
fixture and implementation gates must preserve that order.

## Future Active Output

Only a later authorized resolver implementation may return this active shape:

```js
{
  keyState: "active",
  keyReference: "<requested key reference>",
  publicKeySpkiDer: <fresh Buffer or Uint8Array copy>
}
```

The returned `keyReference` must exactly equal the requested reference. The key
bytes must originate only from the unique selected record. The active output
has no `reasonCategory`, metadata, provider field, trust score, or
authorization result.

Non-active outputs retain the current exact bounded shapes and contain none of:

```txt
keyReference
publicKeySpkiDer
record contents
provider metadata
network metadata
private material
```

## Binding Invariant

Future composition must enforce this invariant internally:

```txt
adapter.publicKeySpkiDer
===
resolverActiveResult.publicKeySpkiDer
```

The composition caller must not provide any independent:

```txt
publicKeySpkiDer
keyState
resolver result
binding verdict
fingerprint as a replacement for resolver ownership
```

No post-resolution public-key replacement, first-match fallback, last-match
fallback, or caller-declared binding is valid.

## Duplicate Records

Existing duplicate behavior remains unchanged:

```txt
zero matches      -> canonical unknown result
one match         -> evaluate the selected record
multiple matches  -> canonical malformed ambiguous result
```

Identical duplicates remain ambiguous. Different key material in duplicate
records does not create precedence, merging, or first/last-match behavior.

## Layer Separation

The responsibilities remain separate:

```txt
resolver
  validates bounded records, selects one record, classifies lifecycle state,
  and later returns bound public bytes only for active state

cryptographic adapter
  imports SPKI DER, enforces Ed25519, and verifies supplied bytes

verification-core
  owns existing bounded reasoning and cryptographic evidence-shape handoff

composition
  orchestrates these components only after separately authorized binding,
  signed-content, precedence, and output contracts are closed
```

The resolver performs no crypto. The adapter performs no resolution or key
state decision. The core does not fetch keys or authorize actions.

## Determinism And Immutability

Future implementation must guarantee that identical bounded inputs produce
byte-equivalent semantic results. It must preserve record order, copy visible
Buffer/Uint8Array ranges, respect offsets, and leave caller objects and backing
buffers unchanged.

The binding must not depend on the system clock, network, database, key store,
environment, random values, generated identifiers, or mutable module cache.
The explicit resolver `evaluationTime` remains the only time input; the crypto
adapter remains time-independent.

## Required Sequence

V25A authorizes no implementation. The mandatory source-bound sequence is:

```txt
V25A key-material binding contract
-> V25A1 resolver binding fixture-scope amendment
-> V25A2 resolver binding fixtures
-> V25A3 fixture-contract test update
-> V25A4 resolver implementation/test taskpack
-> V25A5 resolver binding implementation
-> V25A6 adversarial hardening
-> signed-content binding recovery
-> composition-scope retry
```

V25A must not start V25A1 or composition scope. The existing 12 resolver
fixtures and current tests remain unchanged by this docs-only recovery.

## Permanent Non-Claims

V25A does not create or claim:

- live key store;
- network or database resolution;
- certificate-chain validation;
- private key or key generation;
- signing or receipt signing;
- trust or authorization decision;
- resolver-to-adapter composition implementation;
- A2A or connector enforcement;
- V5 completion.

## Exit Criteria

This gate may close only when the single docs file defines the existing
malformed mapping, the future sole-owner record contract, active and non-active
output confinement, duplicate fail-closed behavior, defensive byte-copy rules,
resolver/adapter separation, implementation sequence, and permanent
non-claims. No source or test behavior changes belong to V25A.

Next gate after V25A closeout:

```txt
V5-VERIFICATION-25A1_RESOLVER_BINDING_FIXTURE_SCOPE_AMENDMENT
```
