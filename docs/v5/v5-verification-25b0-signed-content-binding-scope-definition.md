# V5-VERIFICATION-25B0 - Signed-Content Binding Scope Definition

**Status:** `spec`

**Mode:** docs-only security contract definition
**Current checkpoint:** `V5-VERIFICATION-25A6_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ b403bd2ac3d9cda96f4d93d2da7a8c70c3a92d37`

## Purpose

`V5-VERIFICATION-25B0` defines the signed-content binding contract that must
exist before any signed-content composition, digest helper, canonical bytes
helper, or cryptographic verification composition work starts.

This document answers the core question:

```txt
Which exact canonical byte sequence is a signature verification claim bound to?
```

This gate does not implement signed-content binding. It defines the contract
that later fixtures, tests, helpers, and composition gates must prove.

## Evidence Tags

Every normative statement in this document uses one of these labels:

- `OBSERVED`: present in the current repository.
- `DERIVED`: follows from current repository contracts.
- `PROPOSED`: selected by this scope definition for future gates.
- `RESOLVED_FOR_V1`: selected by this scope definition as a closed V1
  signed-content contract decision.
- `HUMAN_DECISION_REQUIRED`: selected as a recommendation, but still requires
  explicit approval before implementation.
- `OUT_OF_SCOPE`: deliberately not included in this gate.

## Current Repository Evidence

`OBSERVED` The existing cryptographic profile contract in
`lib/v5/cryptographic-profile-contract.js` defines:

- profile identifier: `ed25519-v1`
- signed-content mode: `canonical-message-bytes`
- canonicalization: `json-stable-v1`
- text encoding: `utf-8`
- future runtime primitive: `node:crypto`
- adapter input keys: `algorithm`, `messageBytes`, `publicKeySpkiDer`,
  `signatureBytes`
- message byte bound: 1 through 1,048,576 bytes
- public key material: 44-byte Ed25519 SPKI DER bytes
- signature material: 64-byte raw Ed25519 signature bytes

`OBSERVED` `encodeJsonStableV1(value)` serializes only bounded JSON-like
values, sorts object keys lexically by JavaScript string order, encodes UTF-8
bytes, rejects non-finite numbers, serializes negative zero as `0`, rejects
sparse arrays, rejects accessors, rejects inherited enumerable state, rejects
custom `toJSON`, rejects symbols, rejects cycles, and rejects byte output larger
than 1,048,576 bytes.

`OBSERVED` `V5-VERIFICATION-25A` and later resolver-binding gates define that
the trusted-key resolver is the sole owner of selected public verification key
bytes for a `keyReference`. The adapter must not receive independent caller
key material that bypasses resolver selection.

`OBSERVED` Verification status remains bounded to:

```txt
verified
not_verified
```

`OBSERVED` Existing verification reason categories include:

```txt
signature_valid
missing_signature_evidence
malformed_signature_evidence
payload_digest_mismatch
unsupported_algorithm
unknown_key
revoked_key
expired_key_metadata
key_lookup_unavailable
malformed_trusted_key_record
payload_identity_mismatch
forbidden_trust_claim
forbidden_authorization_claim
forbidden_exchange_claim
```

`DERIVED` The missing V25B contract is not key selection and not raw signature
verification. The missing contract is the exact message and context binding
that produces the `messageBytes` later supplied to the cryptographic adapter.

## Object Separation

`PROPOSED` Future signed-content evaluation must distinguish these objects:

1. Caller-provided semantic payload.
2. Canonical signed-content envelope.
3. Digest and signature verification inputs.

`PROPOSED` A caller must never be allowed to supply these three objects as
independent, mutually inconsistent claims. Later composition must derive
canonical bytes and digest inputs from one bounded signed-content envelope.

## Canonical Signed Bytes

`PROPOSED` The canonical byte sequence is:

```txt
canonicalSignedBytes =
  encodeJsonStableV1(signedContentEnvelopeV1)
```

`PROPOSED` The signed content envelope is a bounded plain JSON object with
exactly these logical fields:

| Field | Decision | Rationale |
| --- | --- | --- |
| `domainLabel` | included | prevents cross-protocol replay |
| `canonicalization` | included | binds the serialization contract |
| `contentType` | included | prevents binary/text and semantic-type confusion |
| `contentVersion` | included | prevents version downgrade or cross-version replay |
| `payloadEncoding` | included | binds the representation of payload bytes or JSON string payload |
| `payload` | excluded from signed envelope | V1 signs the payload through `payloadDigest`; duplicating payload in the envelope would create two payload representations |
| `payloadDigest` | derived and included | binds digest to canonical payload bytes |
| `digestAlgorithm` | included | prevents digest algorithm substitution |
| `keyReference` | included | binds the signature claim to the intended key reference |
| `receiptId` | included when present in the trust object | prevents cross-receipt replay |
| `packageId` | included when present in the trust object | prevents cross-package replay |
| `workspaceId` | included when present in the trust object | prevents cross-workspace replay |
| `agentId` | included when present in the trust object | prevents cross-agent replay |
| `issuedAt` | included as `YYYY-MM-DDTHH:mm:ss.SSSZ` | binds the claim issuance instant |
| `routeReceiptId` | included when present | binds route handoff context |
| `reasoningMetadataDigest` | derived and included when reasoning metadata is present | avoids signing mutable free-form metadata |
| caller-supplied `messageBytes` | forbidden caller control | message bytes are derived only |
| caller-supplied independent `payloadDigest` | forbidden caller control for V1 | digest is recomputed by the binding layer |
| unsigned security-relevant extra fields | forbidden caller control | prevents ambiguous unsigned claims |

`PROPOSED` The exact future helper may choose a stricter subset if repository
fixtures prove a narrower V1 surface. It may not omit fields that are present
and security-relevant to package, receipt, workspace, agent, key, canonical
format, digest, or domain binding.

## Canonicalization

`OBSERVED` The current repository already defines `json-stable-v1` through
`encodeJsonStableV1`.

`PROPOSED` The signed-content binding label for future V25B fixtures is:

```txt
huqan-signed-content-json-v1
```

`PROPOSED` This label maps to the existing `json-stable-v1` byte encoder and
adds the signed-content envelope rules in this document.

`PROPOSED` Canonicalization rules:

| Question | Decision |
| --- | --- |
| Object key ordering | existing `json-stable-v1` sorted own enumerable string keys |
| Unicode normalization | no silent normalization; byte-distinct strings remain distinct |
| Whitespace | no insignificant whitespace outside JSON string escaping |
| Number serialization | existing finite JSON number serialization |
| Negative zero | encoded as `0` by existing encoder |
| `NaN` and `Infinity` | rejected |
| Duplicate JSON keys | rejected before object materialization by future parser/fixture gates |
| `undefined`, `BigInt`, function, symbol | rejected |
| Binary payload | encoded as unpadded canonical base64url JSON string |
| Line endings | no normalization; payload bytes or strings remain explicitly represented |
| Accessors and inherited enumerable state | rejected by existing encoder |

`HUMAN_DECISION_REQUIRED` Unicode normalization policy must be approved before
implementation. This document recommends no normalization for V1 because it
avoids silently collapsing byte-distinct user content into one signed claim.

## Digest Algorithm

`RESOLVED_FOR_V1` V1 digest algorithm:

```txt
sha-256
```

Security rationale:

- broadly interoperable;
- sufficient for the current signed-content digest binding role;
- smaller output than SHA-384 or SHA-512 for fixtures and package fields;
- already familiar to the ecosystem.

`RESOLVED_FOR_V1` V1 digest wire representation:

```txt
digest byte length: 32 bytes
payloadDigest wire representation: 64-character lowercase hexadecimal ASCII
prefix: none
allowed characters: [0-9a-f]
uppercase: rejected
0x prefix: rejected
base64/base64url representation: rejected
incorrect length: rejected
```

`RESOLVED_FOR_V1` The normative V1 invariant is:

```txt
payloadDigest =
lowercaseHex(
  SHA-256(canonicalPayloadBytes)
)
```

`RESOLVED_FOR_V1` Exact V1 wire validation is:

```txt
payloadDigest.length === 64
/^[0-9a-f]{64}$/
```

Internal helper implementations may hold the digest as bytes, but the
canonical JSON envelope field is only the 64-character lowercase hexadecimal
ASCII string. Unknown digest algorithms fail closed. Callers cannot select
arbitrary algorithms, aliases, casing variants, uppercase spellings, or
fallback modes.

`HUMAN_DECISION_REQUIRED` SHA-384 and SHA-512 remain future options only after a
separate compatibility and migration decision.

## Payload And Digest Relation

`RESOLVED_FOR_V1` V1 separates three objects:

```txt
canonicalPayloadObjectV1
canonicalPayloadBytes
signedContentEnvelopeV1
```

`RESOLVED_FOR_V1` The exact V1 canonical payload object is:

```txt
canonicalPayloadObjectV1 = {
  contentType,
  payloadEncoding,
  payload
}
```

Only these three fields enter the payload digest.

`RESOLVED_FOR_V1` The exact V1 canonical payload bytes are:

```txt
canonicalPayloadBytes =
UTF8(
  encodeJsonStableV1(canonicalPayloadObjectV1)
)
```

These fields do not enter `canonicalPayloadObjectV1`:

```txt
payloadDigest
digestAlgorithm
canonicalization
domainLabel
contentVersion
packageId
receiptId
keyReference
workspaceId
agentId
issuedAt
signature
```

`payloadDigest` is excluded because it is derived from
`canonicalPayloadBytes`; including it would create recursion. Context fields
are excluded from the payload digest because they are bound by
`signedContentEnvelopeV1`, not by the payload digest.

`RESOLVED_FOR_V1` The payload digest invariant is:

```txt
payloadDigest == HASH(canonicalPayloadBytes)
```

`RESOLVED_FOR_V1` For V1, `payloadDigest` is derived by the signed-content binding
layer and included in the signed envelope. A caller-provided independent digest
is not accepted as authoritative input.

`PROPOSED` If a future gate allows caller-provided `payloadDigest`, that gate
must recompute the digest from canonical payload bytes and require exact match
before any signature evidence is evaluated.

`DERIVED` This prevents:

```txt
payload A
+ digest for payload B
+ signature over unrelated bytes
```

from becoming a coherent verification claim.

`RESOLVED_FOR_V1` The signed envelope binds two layers:

```txt
1. payload binding:
   digestAlgorithm
   payloadDigest

2. context binding:
   domainLabel
   contentVersion
   canonicalization
   contentType
   payloadEncoding
   packageId / receiptId / keyReference / workspaceId / agentId / issuedAt
   according to their required/optional contract
```

`RESOLVED_FOR_V1` The payload itself is not included a second time inside
`signedContentEnvelopeV1`. The envelope binds payload through `payloadDigest`.

Example V1 payload object:

```json
{
  "contentType": "application/json",
  "payloadEncoding": "utf-8",
  "payload": "{\"claim\":\"example\"}"
}
```

Example V1 signed envelope shape:

```json
{
  "domainLabel": "HUQAN/V5/SIGNED-CONTENT/v1",
  "canonicalization": "huqan-signed-content-json-v1",
  "digestAlgorithm": "sha-256",
  "contentType": "application/json",
  "contentVersion": "v1",
  "payloadEncoding": "utf-8",
  "payloadDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "keyReference": "example-key-reference",
  "contextBinding": {
    "packageId": "example-package",
    "receiptId": "example-receipt",
    "workspaceId": "example-workspace",
    "agentId": "example-agent",
    "routeReceiptId": "example-route"
  },
  "issuedAt": "2026-07-14T13:45:30.123Z"
}
```

## Payload Encoding

`RESOLVED_FOR_V1` V1 supports exactly two payload encoding labels:

```txt
utf-8
base64url
```

`RESOLVED_FOR_V1` Text payload contract:

```txt
payloadEncoding = "utf-8"
payload = JSON string
```

The text payload string value is canonicalized by `encodeJsonStableV1` as part
of `canonicalPayloadObjectV1`. If the encoding label and payload type disagree,
the signed content is malformed.

`RESOLVED_FOR_V1` Binary payload contract:

```txt
payloadEncoding = "base64url"
payload = unpadded base64url JSON string
```

Exact binary rules:

```txt
alphabet: A-Z a-z 0-9 - _
padding: forbidden
+: forbidden
/: forbidden
=: forbidden
whitespace: forbidden
```

Normative syntax validation:

```txt
/^[A-Za-z0-9_-]*$/
```

Syntax validation is not sufficient. V1 must also satisfy the canonical
decode/re-encode invariant:

```txt
base64urlEncode(base64urlDecode(payload)) === payload
```

This rejects alternate, padded, or non-canonical encodings. Empty binary
payloads are allowed only if the product-level content contract permits empty
content; otherwise the higher-level content contract rejects them.

`RESOLVED_FOR_V1` V1 forbids these representations:

```txt
standard base64
padded base64url
hex
byte arrays in JSON
Buffer-shaped objects
raw binary outside the JSON envelope
mixed text/binary interpretation
```

`contentType` defines the media type of the payload. `payloadEncoding` defines
how the JSON `payload` string is interpreted. These fields are not
interchangeable.

## Detached Payload

`HUMAN_DECISION_REQUIRED` Recommended V1 policy:

```txt
V1 scope does not support detached payloads.
```

Security rationale:

- the current repository has no detached payload availability contract;
- no locator trust model exists;
- no content-length binding contract exists;
- allowing digest-only payloads would move critical availability and
  substitution decisions into an unimplemented surface.

`OUT_OF_SCOPE` Detached payload support is a future separate contract. If later
approved, it must bind content length, content type, digest algorithm, external
locator semantics, locator integrity, and availability failure behavior.

## Receipt And Package Binding

`PROPOSED` A signature over content alone is insufficient for HUQAN V5 package
flows. The signed envelope must bind available trust-object context:

```txt
packageId
receiptId
keyReference
workspaceId
agentId
routeReceiptId
policyVersion or policy digest when present
reasoningMetadataDigest when reasoning metadata is present
```

`PROPOSED` Required replay invariant:

```txt
same valid signature
+ same payload bytes
+ different receipt or package context
-> must not silently verify as the same claim
```

`HUMAN_DECISION_REQUIRED` Exact mandatory context fields depend on the future
package/receipt fixture corpus. This document recommends at least `packageId`,
`receiptId`, `keyReference`, `domainLabel`, `canonicalization`, and
`digestAlgorithm` for every signed-content claim that participates in a trust
package or receipt.

## Signature Input Structure

`PROPOSED` Future signature input must be domain-separated, versioned,
length-bounded, and canonicalized. Raw concatenation is forbidden.

Forbidden structure:

```txt
payload || receiptId || keyReference
```

Recommended logical structure:

```txt
{
  "domainLabel": "HUQAN/V5/SIGNED-CONTENT/v1",
  "canonicalization": "huqan-signed-content-json-v1",
  "digestAlgorithm": "sha-256",
  "contentType": "...",
  "contentVersion": "...",
  "payloadEncoding": "...",
  "payloadDigest": "...",
  "keyReference": "...",
  "contextBinding": {
    "packageId": "...",
    "receiptId": "...",
    "workspaceId": "...",
    "agentId": "...",
    "routeReceiptId": "..."
  },
  "issuedAt": "2026-07-14T13:45:30.123Z"
}
```

`PROPOSED` The future helper may flatten this structure if fixtures prove a
simpler canonical envelope. It must preserve domain separation, version labels,
digest binding, key binding, and context binding.

## Domain Separation

`PROPOSED` The V1 domain label is:

```txt
HUQAN/V5/SIGNED-CONTENT/v1
```

`PROPOSED` `domainLabel` is part of the canonical signed bytes. A valid
signature for another HUQAN claim type, another version, another protocol, or
another application must not verify as V5 signed content.

## Issued At Timestamp

`RESOLVED_FOR_V1` V1 includes `issuedAt` in the signed context.

Exact representation:

```txt
UTC RFC 3339 timestamp
fixed millisecond precision
literal trailing Z
```

Exact format:

```txt
YYYY-MM-DDTHH:mm:ss.SSSZ
```

Example:

```txt
2026-07-14T13:45:30.123Z
```

Normative requirements:

```txt
timezone: UTC only
offset forms: rejected
fractional precision: exactly 3 digits
missing milliseconds: rejected
more than 3 fractional digits: rejected
lowercase z: rejected
leap-second representation: rejected for V1
calendar-invalid dates: rejected
```

Regex validation is not sufficient. V1 must also satisfy parse and canonical
re-encode:

```txt
formatUtcMillis(parseTimestamp(issuedAt)) === issuedAt
```

`issuedAt` is not:

```txt
verification time
key expiration time
receipt ingestion time
local timezone time
```

`issuedAt` is the canonical UTC instant claimed for signed-content envelope
production. V25B0 defines timestamp representation and signature binding only.
It does not authorize clock-skew, freshness, or expiration enforcement.

## Ambiguity Rejection

`PROPOSED` Future signed-content binding must fail closed for:

- duplicate keys before object materialization;
- ambiguous Unicode forms when the policy requires exact byte identity;
- unsupported numeric values;
- mixed binary/text encoding;
- unknown canonicalization label;
- unknown content version;
- unknown digest algorithm;
- extra unsigned security-relevant fields;
- missing required fields;
- multiple equivalent encodings;
- caller-provided bytes that disagree with derived bytes;
- caller-provided digest that disagrees with recomputed digest if a later gate
  ever allows caller-provided digest input.

## Provisional Error Taxonomy

`PROPOSED` Future fixture gates may use these docs-level categories:

```txt
unsupported_canonicalization
unsupported_digest_algorithm
malformed_signed_content
payload_digest_mismatch
content_binding_mismatch
detached_payload_not_supported
signature_input_ambiguous
```

`PROPOSED` These are provisional signed-content binding categories. They are
not yet runtime API values and do not expand the current verification-core
reason vocabulary.

## Threat Model

| Attack | Violated invariant | Required rejection behavior | Future gate |
| --- | --- | --- | --- |
| payload substitution | one claim binds one canonical message | `content_binding_mismatch` | 25B1/25B3 |
| digest substitution | digest derives from canonical payload bytes | `payload_digest_mismatch` | 25B1/25B5 |
| message bytes separated from payload | caller cannot choose payload and bytes independently | `signature_input_ambiguous` | 25B3/25B4 |
| valid signature reused with different receipt | context must be signed | `content_binding_mismatch` | 25B1/25B3 |
| valid signature reused with different package | context must be signed | `content_binding_mismatch` | 25B1/25B3 |
| canonicalization downgrade | canonicalization label is signed and allowlisted | `unsupported_canonicalization` | 25B2 |
| algorithm downgrade | digest algorithm is signed and allowlisted | `unsupported_digest_algorithm` | 25B2/25B5 |
| duplicate-key ambiguity | one object has one representation | `signature_input_ambiguous` | 25B2 |
| Unicode ambiguity | equivalent-looking content must not silently collapse | `signature_input_ambiguous` | 25B2 |
| binary/text confusion | payload encoding is signed and uses exact V1 encoding labels | `malformed_signed_content` | 25B1/25B2 |
| truncation | length-bounded canonical bytes and digest mismatch | `payload_digest_mismatch` | 25B5 |
| prefix/suffix concatenation ambiguity | raw concatenation forbidden | `signature_input_ambiguous` | 25B3 |
| cross-protocol replay | domain label is signed | `content_binding_mismatch` | 25B1/25B3 |
| cross-agent replay | agent context is signed when present | `content_binding_mismatch` | 25B1/25B3 |
| cross-workspace replay | workspace context is signed when present | `content_binding_mismatch` | 25B1/25B3 |

## Required Invariants

`PROPOSED` One semantic signed-content object has one canonical byte
representation.

`PROPOSED` One verification claim binds one key, one canonical message, one
signature, and one context.

`PROPOSED` Caller cannot independently choose payload, digest, and signed bytes.

`PROPOSED` Unknown canonicalization or digest algorithm fails closed.

`PROPOSED` Security-relevant context cannot remain unsigned.

`PROPOSED` Equivalent-looking but byte-distinct payloads do not silently
collapse.

`PROPOSED` The same signature cannot be replayed across receipt, package,
workspace, agent, or domain contexts.

## Future Gate Map

| Gate | Goal | Classification | Allowed files | Forbidden files | Dependencies | Acceptance evidence | Stop conditions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `V5-VERIFICATION-25B0` | define signed-content binding scope | docs-only | this document | runtime, tests, fixtures, package files | V25A6 closeout | diff check, scope review, independent review | source conflict or unresolved human decision |
| `V5-VERIFICATION-25B1_CANONICAL_SIGNED_CONTENT_FIXTURES` | add signed-content fixture corpus | fixture-only | future `test/fixtures/v5/signed-content-binding/*.json` | runtime, schema, package, docs except fixture inventory if separately approved | 25B0 closeout | JSON parse, fixture count, threat coverage | fixture shape ambiguity |
| `V5-VERIFICATION-25B2_CANONICALIZATION_CONTRACT_TESTS` | lock canonicalization and ambiguity rules | test-only | future focused canonicalization test file | runtime helper, crypto, package files | 25B1 closeout | targeted tests, full suite | duplicate-key parser gap or unsupported input representation |
| `V5-VERIFICATION-25B3_CANONICAL_BYTES_HELPER_TESTS` | define executable canonical bytes contract | test-only | future canonical bytes helper test file | helper implementation | 25B2 closeout | failing tests expected only if implementation absent, or explicit task-pack decision | required helper surface exceeds scope |
| `V5-VERIFICATION-25B4_CANONICAL_BYTES_HELPER_IMPLEMENTATION` | implement bounded canonical bytes helper | implementation | one helper module and one direct test file | crypto adapter, resolver, verification core, package files | 25B3 and task-pack approval | targeted and full tests | new runtime vocabulary or crypto dependency required |
| `V5-VERIFICATION-25B5_DIGEST_BINDING_ADVERSARIAL_TESTS` | prove digest/message/context mismatch rejection | test-only | one adversarial test file | runtime changes | 25B4 closeout | adversarial tests, full suite | helper cannot express required mismatch |
| `V5-VERIFICATION-25B6_SIGNED_CONTENT_BINDING_CLOSEOUT_AUDIT` | close signed-content binding layer | read-only audit | none | all edits | 25B5 closeout | source/evidence/claim reconciliation | scope drift or claim overreach |

## Explicit Non-Scope

`OUT_OF_SCOPE` This gate does not authorize:

- signature verification implementation;
- crypto adapter change;
- private-key handling;
- signing runtime;
- Trust Package writer changes;
- Trust Package reader changes;
- A2A transport;
- connector enforcement;
- MCP enforcement;
- marketplace behavior;
- certificate chain validation;
- PKI or revocation infrastructure;
- remote key fetching;
- resolver changes;
- verification-core changes;
- package trust decisions;
- action authorization decisions;
- V5 completion claims.

## Human Decisions

| Decision | Options | Recommended option | Security rationale | Compatibility impact | Migration impact | Human approval required |
| --- | --- | --- | --- | --- | --- | --- |
| digest algorithm | SHA-256, SHA-384, SHA-512 | SHA-256 / `sha-256` wire label | balanced interoperability and security for digest binding | aligns with common tooling | future migration possible through allowlist versioning | RESOLVED_FOR_V1 |
| digest wire representation | lowercase hex, uppercase hex, base64, base64url, prefixed hex | lowercase 64-character hex with no prefix | one canonical wire form for fixtures and envelopes | rejects alternate encodings | future migration requires versioned envelope | RESOLVED_FOR_V1 |
| canonicalization format | existing `json-stable-v1`, new canonicalizer | `huqan-signed-content-json-v1` over existing `json-stable-v1` | reuses observed bounded encoder and adds signed-content envelope | minimal new behavior | future version label can migrate | yes |
| domain label | generic, HUQAN V5 specific | `HUQAN/V5/SIGNED-CONTENT/v1` | prevents cross-protocol replay | requires fixtures to include label | future versions need explicit label changes | yes |
| detached payload support | supported, unsupported | unsupported in V1 | avoids locator and availability ambiguity | attached payloads only | detached migration needs separate gates | yes |
| caller-provided digest policy | accept, recompute-match, derive-only | derive-only in V1 | prevents digest/message separation | callers stop supplying authoritative digest | later compatibility can add recompute-match | yes |
| receipt/package fields | payload only, package only, receipt and package, full context | receipt and package plus available workspace/agent context | prevents replay across trust objects | requires context-aware fixtures | package evolution must version context | yes |
| Unicode normalization | normalize, reject ambiguity, preserve exact | preserve exact with no silent normalization | avoids collapsing distinct claims | clients must canonicalize before submission if needed | future normalization needs new label | yes |
| canonical payload bytes input subset | full envelope, payload only, selected payload object | `{ contentType, payloadEncoding, payload }` | avoids digest recursion and context/payload confusion | fixtures can derive one digest input | future change requires versioned envelope | RESOLVED_FOR_V1 |
| binary payload representation | raw bytes, base64 field, base64url field, hex field, unsupported | `payloadEncoding = "base64url"` with unpadded canonical base64url JSON string | prevents binary/text confusion and alternate encodings | fixtures can encode binary deterministically | representation migration needs version bump | RESOLVED_FOR_V1 |
| timestamp inclusion | no timestamp, `issuedAt`, validity window | include `issuedAt` as UTC `YYYY-MM-DDTHH:mm:ss.SSSZ` | binds issuance context without creating trust or freshness enforcement | fixtures have deterministic timestamp strings | future validity windows need separate policy | RESOLVED_FOR_V1 |
| workspace/agent identity inclusion | exclude, optional, required when present | include when present in trust object | prevents cross-workspace and cross-agent replay | package contexts must expose stable IDs | missing legacy fields require migration policy | yes |

## Remaining Decision Classification

`RESOLVED_FOR_V1` These decisions are closed by this document and are not open
human decisions for 25B1:

```txt
digest wire representation
canonicalPayloadBytes input subset
binary payload representation
issuedAt canonical format
```

`MUST_RESOLVE_BEFORE_25B1` No additional signed-content fixture-blocking wire
format decisions are known after the four V1 closures above. If independent
review finds another fixture-shape ambiguity, 25B1 must not start until that
decision is closed in docs.

`MAY_RESOLVE_BEFORE_LATER_IMPLEMENTATION` These decisions remain human-review
items but do not block deterministic 25B1 fixture construction under the V1
contract selected here:

```txt
canonicalization protocol label final approval
domain-separation label final approval
detached payload support beyond V1
caller-provided digest policy beyond derive-only V1
future SHA-384/SHA-512 algorithm agility
required receipt/package context fields for package families not represented in fixtures
Unicode normalization migration beyond preserve-exact V1
workspace and agent identity migration for legacy trust objects
clock-skew, freshness, and expiration enforcement
```

## Closeout Criteria

This docs-only gate may close only if:

- the only changed repository file is this document;
- `git diff --check` passes;
- no runtime, fixture, test, schema, package, MCP, writer, reader, resolver, or
  crypto adapter files change;
- the document does not claim signed-content binding exists;
- the document does not claim cryptographic verification is complete;
- the document does not claim V5 is complete;
- all human decisions are explicit and not hidden as unresolved prose.

## Recommended Next Gate

`V5-VERIFICATION-25B1_CANONICAL_SIGNED_CONTENT_FIXTURES`

That gate, if separately approved, must remain fixture-only and must not add a
canonical bytes helper, digest helper, crypto implementation, resolver
composition, or verification runtime change.
