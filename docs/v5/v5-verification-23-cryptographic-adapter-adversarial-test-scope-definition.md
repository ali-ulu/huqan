# V5-VERIFICATION-23 Cryptographic Adapter Adversarial Test Scope

## Purpose And Boundary

V23 defines the adversarial regression contract for the implemented bounded
Ed25519 adapter. This gate is docs-only. It adds no tests, adapter patch,
fixture, dependency, schema, runtime, or MCP change.

The future V24 work must begin with a failing reproducer against canonical
`main`. A production change is allowed only when that reproducer demonstrates
a violation of an existing V17A-V22 contract, the reproducer is preserved,
and the narrow fix needs no new API, state, reason, dependency, or undefined
behavior decision.

## Canonical System Under Test

The system under test remains:

```txt
lib/v5/cryptographic-verification-adapter.js
module export: verifyCryptographicEvidence
call shape: verifyCryptographicEvidence(input)
```

The input is one plain object with own enumerable data properties only and
exactly these four keys:

```txt
algorithm
messageBytes
publicKeySpkiDer
signatureBytes
```

The only accepted real algorithm is the exact, case-sensitive string
`ed25519-v1`. The adapter uses Node built-in `node:crypto` only. It does not
resolve keys, canonicalize application values, sign, persist, or compose trust
or authorization decisions.

The output vocabulary remains exactly:

```txt
{ cryptographicState: "valid" }
{ cryptographicState: "invalid", reasonCategory: "signature_invalid" }
{ cryptographicState: "malformed", reasonCategory: "input_malformed" }
{ cryptographicState: "malformed", reasonCategory: "message_malformed" }
{ cryptographicState: "malformed", reasonCategory: "public_key_malformed" }
{ cryptographicState: "malformed", reasonCategory: "signature_malformed" }
{ cryptographicState: "unsupported", reasonCategory: "algorithm_unsupported" }
```

No new state, reason, field, API, byte format, bound, or exception mapping may
be invented by V24.

## Permanent Regression Floor

The V24 suite must preserve all existing V22 behavior before adding new cases:

- RFC 8032 Ed25519 TEST 2 returns `valid`.
- The four structurally valid negative vectors return `invalid/signature_invalid`.
- Case 08 rejects the 43-byte SPKI before `crypto.verify` as
  `malformed/public_key_malformed`.
- Unsupported algorithms return `unsupported/algorithm_unsupported`.
- Empty messages return `malformed/message_malformed`.
- Wrong-length signatures return `malformed/signature_malformed`.
- A post-validation `crypto.verify` exception returns
  `malformed/input_malformed` without leakage.
- Buffer and Uint8Array inputs have parity, including offset views.
- Caller inputs remain unchanged and repeated calls are deterministic.
- All 17 canonical fixtures remain consumable exactly once.

## Root And Property Matrix

V24 must cover null, undefined, booleans, numbers, strings, bigint, symbol,
function, arrays, Date, RegExp, Map, Set, plain objects and null-prototype
objects according to current V21/V22 behavior. It must also cover frozen and
sealed roots, inherited required and unknown fields, own unknown fields,
non-enumerable required and unknown fields, own symbols, getter-bearing
required and unknown fields, and getters that throw.

The suite must prove that unsupported roots fail closed, inherited fields are
not accepted, unknown own fields fail closed, getters are not executed, and
malformed roots never throw through the public API. Proxy semantics are not a
mandatory V23/V24 contract unless an existing canonical contract is extended
by a separately approved source update.

## Algorithm Matrix

The future tests must exercise exact `ed25519-v1`, uppercase and mixed-case
variants, leading/trailing/embedded whitespace, tab, newline, NUL/control
characters, the empty string, synthetic `test-structural-v1`, Ed25519 aliases,
URI/provider-shaped identifiers, a bounded overlong identifier, and
non-string values.

The assertions must preserve these rules:

- no trimming;
- no case folding;
- no alias or fallback;
- no synthetic algorithm substitution;
- unsupported strings remain `algorithm_unsupported`;
- malformed non-strings remain `input_malformed`;
- no unsupported input reaches `crypto.verify`.

## Byte-Type And View Matrix

Each byte-bearing field must be tested with accepted Buffer and Uint8Array
values and rejected ArrayBuffer, SharedArrayBuffer, DataView, Uint16Array,
Uint32Array, Int8Array, plain arrays, strings, boxed strings, numeric-key
objects, stream-like objects, path-like objects, and KeyObject values.

The matrix must include zero-offset and non-zero-offset views, shortened views,
views ending before the backing buffer, Buffer slices and subarrays,
overlapping views, and frozen roots containing mutable byte views. It must
prove that only visible view bytes are copied and used. Detached buffers,
cross-realm typed arrays, and concurrently mutated SharedArrayBuffers remain
undefined semantics and are explicit stop conditions, not invented behavior.

## Message Boundary Matrix

Use deterministic in-memory values for lengths 0, 1, the RFC vector length,
1,048,575, 1,048,576, and 1,048,577. Also cover wrong types, missing fields,
views whose backing buffer exceeds the visible bound, a view exactly at the
maximum, and a view one byte above it.

No one-megabyte JSON fixture is to be committed. The future suite must remain
bounded and must not introduce uncontrolled fuzzing, huge allocation, or
unbounded property generation.

## Public-Key Matrix

Cover 43-byte, exact 44-byte valid Ed25519 SPKI DER, and 45-byte values; random
or malformed 44-byte DER; malformed tags and lengths; altered Ed25519 OID;
malformed BIT STRING; PEM, JWK, raw 32-byte key, certificate, private-key DER,
KeyObject, provider-shaped, and key-store-shaped values.

All length, import, and key-type failures remain
`malformed/public_key_malformed`. No malformed key may reach `crypto.verify`.
No PEM/JWK/raw-key fallback, auto-detection, private key, certificate chain,
or key material may be committed. An ephemeral public-only non-Ed25519 key
may be generated in a future test only if no private material is persisted and
no fixture is created.

## Signature Matrix

Cover empty, 1-byte, 63-byte, exact 64-byte valid, exact 64-byte all-zero,
exact 64-byte mutated, 65-byte, overlong, string, hex string, base64 string,
ArrayBuffer, DataView, Buffer, Uint8Array, and offset views.

Wrong type or length remains `malformed/signature_malformed`. A structurally
valid exact 64-byte wrong signature remains `invalid/signature_invalid`. No
alternate decoding is permitted.

## Exception And Result Matrix

The future suite must distinguish three stages:

1. Public-key import failure returns `malformed/public_key_malformed`.
2. Successful import of a non-Ed25519 key returns
   `malformed/public_key_malformed`.
3. A post-validation `crypto.verify` exception returns
   `malformed/input_malformed`.

The public API must not throw or expose exception names, messages, stacks,
OpenSSL/Node details, input bytes, key material, or signature bytes. Every
result assertion must be an exact object assertion with no extra, undefined,
null, explanatory, trust, package-trust, or authorization fields. The approved
V22 test-mocking mechanism remains the only exception-test mechanism; no
public dependency-injection parameter or test-only export may be added.

## Validation Precedence

V24 must preserve the exact V21/V22 order. Compound-invalid cases must cover:

- unknown root field plus unsupported algorithm;
- missing required field plus malformed byte type;
- unsupported algorithm plus malformed message;
- malformed message plus malformed public key;
- malformed public key plus malformed signature;
- malformed signature plus cryptographically invalid bytes;
- valid structure plus a `crypto.verify` exception.

Earlier failures must dominate later checks. V24 must not create a new
precedence rule.

## Determinism, Immutability, And Side Effects

The suite must prove repeated valid, invalid, and malformed calls are
deep-equal; insertion order does not alter semantics; locale, timezone,
environment variables, current time, randomness, mutable module cache, and
call order do not alter results.

Pre/post snapshots must cover the root, message, public-key, signature,
Uint8Array views, backing buffers, bytes outside views, overlapping views,
frozen/sealed roots, fresh outputs, and output mutation isolation.

Inspection and bounded tests must establish no filesystem write, network,
database, key-store, environment mutation, process-global mutation, sensitive
logging, temporary file, key generation, or signing behavior. Tests must avoid
invasive global monkeypatching that destabilizes the full suite.

## Fixture And Core Boundaries

The existing 17 JSON fixtures remain byte-for-byte unchanged. V24 may read
them but must not rewrite, expand, replace, mutate, regenerate, or alter their
provenance, expected vocabulary, or case 08 declaration.

Adapter results may pass through
`normalizeCryptographicVerificationEvidence` only to prove bounded handoff
compatibility. V24 must not change verification precedence, compose resolver
state, decide package trust or authorization, sign receipts, or add transport
or exchange behavior.

## Resource Safety And Undefined Semantics

Future adversarial cases must stay deterministic and bounded. No uncontrolled
fuzzing, dependency-based property testing, infinite recursion, huge
allocation, or unbounded generated input is permitted.

The following are explicit stop conditions rather than behavior to invent:

- Proxy objects;
- detached ArrayBuffers;
- cross-realm typed arrays;
- concurrently mutated SharedArrayBuffers;
- crypto-provider or FIPS-mode-specific behavior outside the canonical contract;
- platform-specific OpenSSL error classification.

If a concrete canonical reproducer requires any of these semantics, stop and
open a contract-gap review. Do not patch by assumption.

## Future V24 Scope And Lifecycle

Default allowed file:

```txt
test/v5-cryptographic-verification-adapter-adversarial.test.js
```

Conditional production file:

```txt
lib/v5/cryptographic-verification-adapter.js
```

The production file may change only after a failing adversarial reproducer is
demonstrated against canonical `main`, committed before or alongside the
narrow fix, and shown to be an existing V17A-V22 contract violation. No other
file is pre-authorized.

V24 lifecycle:

1. Add adversarial tests first.
2. Run them against canonical main behavior.
3. Preserve every failing reproducer.
4. Patch production only for concrete contract violations.
5. Run targeted, related, and full suites.
6. Open one narrow PR.
7. Perform independent read-only review.
8. Merge only the exact approved head.
9. Run clean post-merge smoke.
10. Complete closeout audit.

Required validation commands are:

```bash
node --test test/v5-cryptographic-verification-adapter-adversarial.test.js
node --test test/v5-cryptographic-profile-contract.test.js test/v5-cryptographic-adapter-fixtures.test.js test/v5-cryptographic-verification-adapter.test.js test/v5-cryptographic-verification-adapter-adversarial.test.js test/v5-verification-core.test.js
npm test
git diff --check main...HEAD
git diff --name-only main...HEAD
git status --short
```

## Forbidden Scope And Non-Claims

V23 must not add adversarial tests, modify the adapter, change fixtures,
profile, core, resolver, schema, validator, package, lockfile, dependency,
runtime, or MCP surfaces. It must not add key generation, signing, resolver
composition, trust, authorization, A2A, connector enforcement, or a
V5-complete claim.

V23 and its future V24 work do not claim:

- key resolution or key store;
- certificate-chain validation;
- key generation or signing;
- receipt signing;
- network/database provider;
- resolver composition;
- final package trust;
- authorization decision;
- A2A or connector enforcement;
- V5 completion.

## Exit Criteria For V23

This docs-only gate is complete when the single document defines the current
adapter contract, permanent V22 regression floor, bounded adversarial matrices,
precedence and exception boundaries, deterministic/immutability/resource
rules, undefined-behavior stops, reproducer-first V24 lifecycle, forbidden
scope, and permanent non-claims. No implementation or test file is part of
this gate.

Next gate after merge and closeout:

```txt
V5-VERIFICATION-24_CRYPTOGRAPHIC_ADAPTER_ADVERSARIAL_TESTS
```
