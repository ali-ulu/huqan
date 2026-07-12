# V5-VERIFICATION-25A4 Resolver Binding Implementation Taskpack

## Status And Boundary

**Mode:** implementation taskpack only

**Current checkpoint:** \`V5-VERIFICATION-25A3_CLOSEOUT_AUDIT_GREEN\`

**Canonical base:** \`main @ 538deb738d951235354458c8451fcd0b42647e9c\`

This document makes a later, separately authorized
\`V5-VERIFICATION-25A5_RESOLVER_BINDING_IMPLEMENTATION\` directly executable.
V25A4 creates no source, test, fixture, schema, package, runtime, MCP, adapter,
or cryptographic behavior.

Normative sources are:

1. \`v5-verification-25a-key-material-binding-contract.md\`
2. \`v5-verification-25a1-resolver-binding-fixture-scope-amendment.md\`
3. the merged A2 20-fixture corpus and A3 fixture-contract test
4. the current resolver source, original 12 fixtures, and current resolver tests
5. V7-V16 resolver documents where consistent with the newer merged sources

Merged source, fixture, test, and closeout evidence take precedence over an
older planning document. No unresolved contract conflict remains.

## Exact Future V25A5 File Scope

V25A5 may modify exactly:

\`\`\`txt
lib/v5/trusted-key-resolver.js
test/v5-trusted-key-resolver-binding.test.js
\`\`\`

No third file is authorized. The following remain unchanged:

\`\`\`txt
test/v5-trusted-key-resolver.test.js
test/v5-trusted-key-resolver-adversarial.test.js
test/v5-trusted-key-resolver-fixtures.test.js
test/v5-trusted-key-resolver-binding-fixtures.test.js
test/fixtures/v5/trusted-key-resolver/
test/fixtures/v5/trusted-key-resolver-binding/
lib/v5/cryptographic-verification-adapter.js
lib/v5/verification-core.js
package.json
package-lock.json
\`\`\`

If this exact two-file surface cannot implement and prove this contract, stop:

\`\`\`txt
V5-VERIFICATION-25A4_BLOCKED_BY_IMPLEMENTATION_TEST_SURFACE_GAP
\`\`\`

## Public API Preservation

The existing synchronous named CommonJS export remains exact:

\`\`\`js
const { resolveTrustedKeyState } = require('../lib/v5/trusted-key-resolver');

module.exports = {
  resolveTrustedKeyState
};
\`\`\`

\`resolveTrustedKeyState(input)\` keeps one argument and returns a fresh bounded
object. It adds no class, default export, callback, promise, second public
function, composition API, dependency injection API, or crypto API. Inspectable
caller input must fail closed rather than leaking an exception.

## Root Input Contract

The root remains a plain object with only these own enumerable keys:

\`\`\`txt
keyReference
records
evaluationTime
\`\`\`

Root-level \`publicKeySpkiDer\` remains unauthorized. Binding fixture case 19
therefore returns the existing exact malformed root result. Do not add
\`keyState\`, \`cryptographicState\`, \`payloadDigest\`, \`signatureBytes\`,
\`algorithm\`, \`provider\`, or a key-store reference to the root.

\`keyReference\` remains the current bounded exact string: non-empty, at most
256 code units, no leading/trailing or embedded whitespace/control characters,
no path/query/fragment/at-sign form, no URL, and no scheme other than the
current permitted \`test-key:\` form. Matching is exact string equality. It
has no coercion, trimming, case folding, public-byte equality, digest lookup,
or fingerprint lookup.

\`evaluationTime\` remains required canonical UTC:

\`\`\`txt
YYYY-MM-DDTHH:mm:ss.sssZ
\`\`\`

It is parsed as an instant. No lexical timestamp comparison, local time,
\`Date.now()\`, implicit timezone, or normalized non-canonical timestamp is
allowed. \`records\` remains a required dense array and may be empty.

## Additive Record Allowlist

The current record allowlist gains exactly one field:

\`\`\`txt
keyReference
status
expiresAt
publicKeySpkiDer
\`\`\`

No other record property is authorized. \`publicKeySpkiDer\` is optional for a
structurally valid record but mandatory for the unique selected record that
would otherwise resolve as active.

Unknown record fields fail with the existing exact malformed mapping, including:

\`\`\`txt
publicKeyPem
publicKeyJwk
rawPublicKey
keyObject
keyStoreHandle
provider
endpoint
certificate
privateKey
fingerprint
\`\`\`

No metadata bag is authorized. Recursive forbidden-material checks remain in
force for all non-key values. The implementation may special-case only the
direct \`record.publicKeySpkiDer\` field so a supported byte container is not
mistaken for an unsafe non-plain object.

## Runtime Public-Key Contract

\`publicKeySpkiDer\` is runtime public material. It accepts only:

\`\`\`txt
Buffer
Uint8Array
\`\`\`

It must contain exactly 44 visible bytes. For a typed-array view, visibility is
its own \`byteOffset\` and \`byteLength\`, not the complete backing buffer.

Reject as malformed record input:

\`\`\`txt
ArrayBuffer
DataView
Uint8ClampedArray or another typed array
string
plain array
plain object
fixture descriptor object
KeyObject
PEM
JWK
raw 32-byte fallback
private-key material
provider/key-store reference
\`\`\`

The resolver only checks container type and visible length. It must not import
\`node:crypto\`, parse DER/SPKI, inspect an OID, enforce Ed25519, verify a
signature, parse a certificate, decode/coerce input, or provide a crypto
fallback.

A 44-byte opaque value remains eligible for active when all resolver
conditions pass. Its length does not claim valid DER, Ed25519 validity,
signature verification, package trust, or authorization.

## Active Output And Copy Semantics

V25A5 pins \`Buffer\` as the only active-output byte type. A unique selected,
valid, non-expired active record returns exactly:

\`\`\`js
{
  keyState: 'active',
  keyReference: '<exact requested keyReference>',
  publicKeySpkiDer: Buffer
}
\`\`\`

The Buffer contains exactly 44 visible bytes copied from the selected record.
For both Buffer and Uint8Array input, return a fresh Buffer. An implementation
equivalent to \`Buffer.from(value)\` is allowed only after tests prove it copies
the visible bytes, respects offsets, and cannot alias input storage.

Every call returns a fresh output object and Buffer. Mutating one output cannot
mutate input records, input bytes, another output, or a later call. The active
output has no \`reasonCategory\`, record object, status, expiresAt, provider
metadata, trust score, authorization result, cryptographic state, or extra key.

## Non-Active Output Confinement

Existing shapes remain exact:

\`\`\`txt
unknown     -> { keyState: 'unknown', reasonCategory: 'unknown_key' }
revoked     -> { keyState: 'revoked', reasonCategory: 'revoked_key' }
expired     -> { keyState: 'expired', reasonCategory: 'expired_key_metadata' }
unavailable -> { keyState: 'unavailable', reasonCategory: 'key_lookup_unavailable' }
malformed   -> { keyState: 'malformed', reasonCategory: 'malformed_trusted_key_record' }
\`\`\`

No state or reason is renamed or added. Every non-active output omits
\`keyReference\`, \`publicKeySpkiDer\`, status, expiresAt, record data, public
key digest, provider metadata, explanation, trust score, and authorization
result.

## Exact Validation Order

The existing resolver order remains normative. V25A5 adds public-key validation
inside whole-record validation, before matching:

1. Reject a non-plain root input.
2. Reject unknown root keys. Missing fields then fail their existing validators.
3. Reject invalid or missing root \`keyReference\`.
4. Reject invalid or missing \`evaluationTime\`; parse its instant.
5. Reject a non-dense or non-array \`records\`.
6. Reject forbidden record content, while allowing only a direct supported
   runtime public-key byte container at \`record.publicKeySpkiDer\`.
7. Validate every record before selection: plain shape, exact allowlist,
   key reference, status, optional timestamp, and optional public-key type and
   visible length.
8. Select records using \`record.keyReference === input.keyReference\`.
9. More than one match returns malformed.
10. Zero matches returns unknown.
11. A unique selected unavailable record returns unavailable.
12. A unique selected revoked record returns revoked.
13. A selected unknown record returns unknown; selected malformed returns
    malformed; explicitly expired returns expired.
14. If a selected otherwise-active record has \`expiresAt <= evaluationTime\`,
    return expired.
15. Require \`publicKeySpkiDer\` for the selected otherwise-active record.
16. Copy visible bytes into a fresh Buffer and return the exact active object.

Earlier failure dominates every later state. Step 7 validates every record,
including nonmatching records. Consequently:

- case 11, revoked plus malformed present key, returns malformed;
- case 20, active matching record plus malformed nonmatching record, returns
  malformed;
- lifecycle state and selection never hide an earlier structural failure.

## Lifecycle, Match, And Expiry Rules

The exact status vocabulary remains:

\`\`\`txt
active
unknown
revoked
expired
unavailable
malformed
\`\`\`

Match behavior remains:

\`\`\`txt
zero matches       -> unknown
one match          -> evaluate it
multiple matches   -> malformed
\`\`\`

Identical duplicates and different-key duplicates both remain ambiguous. There
is no first-match, last-match, merge, fallback, precedence, public-key
equality lookup, or fingerprint lookup.

Expiry is instant-based:

\`\`\`txt
expiresAt < evaluationTime   -> expired
expiresAt == evaluationTime  -> expired
expiresAt > evaluationTime   -> continue only toward active
\`\`\`

Case 15 remains unknown even when its record bytes equal an active fixture.
Cases 16 and 17 retain deep-equal malformed outputs.

## Fixture Serialization Boundary

The resolver does not understand JSON descriptors. A value such as:

\`\`\`js
{ kind: 'buffer-hex', hex: '...' }
\`\`\`

is malformed runtime input. The new V25A5 test alone materializes A2 fixture
descriptors on deep copies:

\`\`\`txt
buffer-hex     -> fresh Buffer
uint8array-hex -> fresh Uint8Array
raw-json       -> raw JSON value
absent         -> absent
\`\`\`

It passes actual runtime values to the resolver and compares a successful
Buffer against fixture-only \`publicKeySpkiDerHex\`. It does not rewrite
fixtures or accept descriptors as successful resolver input.

## Required V25A5 Test Work

\`test/v5-trusted-key-resolver-binding.test.js\` must load and consume every
one of the 20 binding fixtures exactly once as corpus coverage. It must lock:

\`\`\`txt
exact filename/caseId table
descriptor materialization on deep copies
exact expected state/reason mapping
active keyReference equality
active Buffer byte equality with publicKeySpkiDerHex
absence of key material from every non-active output
case 11 and case 20 whole-record precedence
case 15 reference mismatch remains unknown
cases 16 and 17 remain equally ambiguous
\`\`\`

It must also test properties not expressible in JSON:

\`\`\`txt
active Buffer input returns a fresh Buffer
active Uint8Array input returns a fresh Buffer
non-zero Uint8Array byteOffset and byteLength are respected
bytes outside a view are ignored
returned Buffer aliases neither Buffer input nor Uint8Array backing storage
input root, records array, record, and input bytes remain unchanged
mutating one active output cannot alter another or a later call
repeated calls are byte-equivalent and deep-equal
opaque 44-byte input is not crypto-parsed
root-level publicKeySpkiDer remains malformed
descriptor-shaped runtime object remains malformed
\`\`\`

The test must not import the adapter, verification core, crypto, a key store,
or a helper module. It must not modify the A3 fixture-contract test.

## Existing Regression Floor

V25A5 must run unchanged:

\`\`\`txt
test/v5-trusted-key-resolver-fixtures.test.js
test/v5-trusted-key-resolver.test.js
test/v5-trusted-key-resolver-adversarial.test.js
test/v5-trusted-key-resolver-binding-fixtures.test.js
test/fixtures/v5/trusted-key-resolver/ (12 files)
test/fixtures/v5/trusted-key-resolver-binding/ (20 files)
\`\`\`

The original corpus preserves six states, current reason vocabulary, fixed-time
parsing, equality-expired behavior, unknown-field behavior, recursive
forbidden-material behavior, and duplicate behavior. Old fixtures or tests
must not be patched to make V25A5 pass.

## Error, Determinism, And Side Effects

Malformed caller input returns bounded malformed output; it does not leak an
exception, error message, stack, input echo, or byte material. V25A5 has no
system clock, \`Date.now()\`, randomness, network, database, key store,
filesystem write, \`node:crypto\`, key generation, signing, environment-driven
semantic branch, hidden mutable module cache, input mutation, or record
reordering.

## Adapter Boundary

The active output is shape-compatible with the adapter's existing
\`publicKeySpkiDer\` input field only. V25A5 must not import or invoke the
adapter, verify a signature, parse SPKI/DER, produce \`cryptographicState\`,
make a trust or authorization decision, or add composition.

## Directly Implementable Pseudocode

\`\`\`txt
malformedResult():
  return { keyState: 'malformed', reasonCategory: 'malformed_trusted_key_record' }

validatePublicKey(value):
  if Buffer.isBuffer(value):
    return value.length === 44
  if value is Uint8Array and not another typed array:
    return value.byteLength === 44
  return false

copyPublicKey(value):
  # Called only after validatePublicKey succeeds.
  return Buffer.from(value)

validateRecord(record):
  reject non-plain record
  reject keys outside keyReference, status, expiresAt, publicKeySpkiDer
  reject invalid record keyReference, status, or present expiresAt
  reject present publicKeySpkiDer unless validatePublicKey succeeds
  accept record

resolveTrustedKeyState(input):
  reject non-plain root -> malformed
  reject unknown root keys -> malformed
  reject invalid root keyReference -> malformed
  parse required evaluationTime; reject failure -> malformed
  reject non-dense records array -> malformed
  reject forbidden record content except a direct supported public key field
  reject when any validateRecord(record) fails
  matches = records where record.keyReference === input.keyReference
  if matches.length > 1: return malformed
  if matches.length === 0: return unknown
  record = matches[0]
  if record.status === 'unavailable': return unavailable
  if record.status === 'revoked': return revoked
  if record.status === 'unknown': return unknown
  if record.status === 'malformed': return malformed
  if record.status === 'expired': return expired
  if record.expiresAt exists and parsed expiresAt <= evaluationTime: return expired
  if publicKeySpkiDer is absent: return malformed
  return active with exact requested reference and copyPublicKey(record.publicKeySpkiDer)
\`\`\`

## Required V25A5 Validation

\`\`\`bash
node --test test/v5-trusted-key-resolver-binding.test.js

node --test \
  test/v5-trusted-key-resolver-fixtures.test.js \
  test/v5-trusted-key-resolver-binding-fixtures.test.js \
  test/v5-trusted-key-resolver.test.js \
  test/v5-trusted-key-resolver-binding.test.js \
  test/v5-trusted-key-resolver-adversarial.test.js

node --test \
  test/v5-trusted-key-resolver-binding.test.js \
  test/v5-cryptographic-verification-adapter.test.js \
  test/v5-verification-core.test.js

npm test

git diff --check main...HEAD
git diff --name-only main...HEAD
git status --short
git remote get-url origin
\`\`\`

The future commit message is:

\`\`\`txt
feat: implement V5 resolver key-material binding
\`\`\`

Independent review must prove the exact two-file scope, unchanged public API and
root allowlist, one-field record amendment, whole-record validation, mandatory
active key, fresh Buffer output, non-active key confinement, cases 11/20
precedence, cases 16/17 ambiguity, case 15 unknown result, unchanged corpora,
no crypto/adapter behavior, green tests, clean diff, and clean worktree.

## Permanent Non-Claims

V25A5 does not add or claim:

\`\`\`txt
live key store
network/database lookup
certificate-chain validation
DER/SPKI parsing in the resolver
Ed25519 validation in the resolver
private key, seed, key generation, rotation, or signing
receipt signing
adapter invocation
composition implementation
package trust
authorization decision
A2A or connector enforcement
marketplace
AgentAction policy engine
V5 completion
\`\`\`

## Stop Conditions

Stop V25A5 if it requires a third changed file, a new keyState or
reasonCategory, an original fixture/test change, resolver crypto or adapter
behavior, network/database/key-store/filesystem integration, another active
output container, or a validation order inconsistent with this taskpack.

## Exit Criteria

This A4 docs-only taskpack is complete when this one file pins the exact
two-file V25A5 scope, unchanged API/root contract, additive record field,
validation order, Buffer copy semantics, 20-fixture execution, original
12-fixture regression floor, direct synthetic tests, validation commands,
review requirements, and permanent non-claims. It does not start V25A5.
