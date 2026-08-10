# ATP v0.1 — Trust Receipt Bundle

A **receipt bundle** is a self-contained, hash-sealed export of a chained
sequence of trust receipts. It is designed to be re-verified by a party that has
only the bundle: no database, no server, no in-memory state, and no access to the
implementation that produced it.

This document specifies the format and the verification algorithm completely
enough to implement independently, in any language. If you have to read HUQAN's
source to verify a bundle, this document has failed and that is a defect worth
reporting.

## Status and scope

This describes the bundle as it is produced today by HUQAN's export path. It is
descriptive, not aspirational: nothing here proposes a change to the format.

The bundle is an **internal, full trust artifact**. Every field of every receipt
is present and unredacted. A public-safe or redacted receipt format is separate
future work and is not this document.

## Envelope

```json
{
  "schemaVersion": "v4-receipt-bundle-v1",
  "workspaceId": "default",
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "receiptCount": 3,
  "bundleHash": "be51f403…",
  "receipts": [ … ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | string | `v4-receipt-bundle-v1`, or `v4-receipt-bundle-v2` if any receipt declares `v4-receipt-v2` |
| `workspaceId` | string | workspace the receipts belong to |
| `exportedAt` | string | ISO-8601 timestamp of export; **not** covered by `bundleHash` |
| `receiptCount` | integer | number of entries in `receipts` |
| `bundleHash` | string | lowercase hex SHA-256 sealing the `receipts` array |
| `receipts` | array | chained receipt records, in chain order |

`receipts` may be empty. An empty bundle is a valid, verifiable bundle: absence
of receipts is a truthful state, not an error.

## Primitives

Two primitives are used everywhere below. Implement these first.

### `canonicalJson(value)` — deterministic serialization

RFC 8259 permits several byte sequences for the same logical value, so
"RFC 8259, minified, sorted keys" is **not** sufficient to pin a hash input.
Every rule below is load-bearing; each one has been observed to diverge between
two conforming implementations.

Serialize `value` as RFC 8259 JSON with:

1. **no insignificant whitespace** — no spaces, no newlines, no indentation, and
   no space after `:` or `,`;
2. **object keys sorted ascending**, recursively, at every level;
3. **array order preserved** — order is semantically meaningful in arrays and
   must never be sorted.

#### Key ordering

Sort by **UTF-16 code unit**, ascending — the ordering JavaScript's
`Array.prototype.sort()` applies to strings by default.

This is not the same as sorting by Unicode code point, and the difference is
observable. A supplementary character such as `U+1F600` is stored as the
surrogate pair `D83D DE00`, so under UTF-16 ordering it sorts **before**
`U+E000`, while code-point ordering puts `U+E000` first. Implementations whose
native sort compares code points — Python's `sorted()`, for one — must convert
to UTF-16 code units before comparing, or they will emit a different byte
sequence and compute a different hash.

`metadata` is an arbitrary object with no restriction on key content, so
non-ASCII and supplementary keys are possible and this rule is reachable in
practice.

#### String serialization

Emit strings as UTF-8 text. Specifically:

- `"` and `\` are escaped as `\"` and `\\`;
- `U+0008`, `U+0009`, `U+000A`, `U+000C`, `U+000D` use their short escapes
  `\b`, `\t`, `\n`, `\f`, `\r`;
- every other code point below `U+0020` uses `\u00XX` with **lowercase** hex
  digits;
- **every other character is emitted literally, never as `\uXXXX`** — a Turkish
  `ş` is the two UTF-8 bytes `C5 9F`, not the six ASCII bytes `ş`;
- an **unpaired UTF-16 surrogate** is emitted as `\uXXXX` with lowercase hex,
  because it has no valid UTF-8 encoding.

The literal-character rule is the one most implementations get wrong by default.
Python's `json.dumps` escapes non-ASCII unless `ensure_ascii=False` is passed,
which changes the bytes and therefore the hash.

No Unicode normalization is applied at any point. `"é"` (`U+00E9`) and
`"é"` (`U+0065 U+0301`) are different strings, hash differently, and must
not be folded together.

#### Number serialization

Numbers use **ECMAScript `Number::toString`** semantics — what JavaScript's
`JSON.stringify` emits. RFC 8259 does not define a canonical lexical form, so
this must be stated explicitly rather than left to each language's default.

**Choice of notation.** Zero serializes as `0`. For any other finite value,
plain decimal is used when

```text
1e-6 <= abs(x) < 1e21
```

and scientific notation otherwise. The boundaries are inclusive below and
exclusive above exactly as written: `1e-6` is `0.000001`, while `9.99e-7` is
`9.99e-7`; `9.99e20` is `999000000000000000000`, while `1e21` is `1e+21`.

**Exponent form.** Scientific notation carries a sign and **no zero padding**:
`1e-7`, not `1e-07`; `1e+21`, not `1e+021`.

Several languages differ on both points. Python's `repr` switches to scientific
notation at `1e-5` rather than `1e-7` and pads single-digit exponents, so a
value this format writes as `0.00001` becomes `1e-05` and `1e-7` becomes
`1e-07` — different bytes, different hash.

`-0` serializes as `0`. Integral values carry no fractional part: `1.0`
serializes as `1`. Non-finite values (`NaN`, `Infinity`) cannot appear, since
they are not representable in JSON.

Booleans and `null` serialize as ordinary JSON.

### `sha256Hex(text)` — digest

SHA-256 over the **UTF-8 bytes** of `text`, rendered as **lowercase**
hexadecimal.

## Receipt record

Each entry of `receipts` is a canonical receipt payload plus two chain fields.

The canonical v1 payload has exactly these keys:

```text
schemaVersion   receiptId       receiptKind    decision
verdict         status          admissionId    workspaceId
actor           agentId         memoryDraftId  provenanceId
trustPolicyVersion              approvalId     approvalStatus
reason          riskScore       createdAt      metadata
```

`schemaVersion` is `v4-receipt-v1`. `riskScore` is a number and defaults to `0`.
`metadata` is an object and defaults to `{}`. Every other field is a string;
absent values are the empty string rather than `null` or a missing key. A v2
receipt declares `v4-receipt-v2` and adds one key, `trustRoot`.

Two further keys complete the record:

| Field | Meaning |
| --- | --- |
| `previousReceiptHash` | `receiptHash` of the preceding record, or the genesis marker for the first |
| `receiptHash` | lowercase hex SHA-256 over this record excluding `receiptHash` itself |

The genesis marker is the exact string:

```text
genesis:v4-receipt-chain
```

It is an explicit sentinel so that "no predecessor" can never be confused with an
empty string, `null` or a missing field.

### Receipt hash

```text
hashable    = canonical payload  +  { previousReceiptHash }
receiptHash = sha256Hex(canonicalJson(hashable))
```

`previousReceiptHash` is **part of what gets hashed**, not a sibling field
alongside the hash. This is what makes a *partial* edit detectable: altering any
receipt's content changes its own recomputed hash, which breaks the link the
*next* receipt already committed to. An edit cannot be hidden by patching only
the receipt that was altered.

It does not make the chain tamper-proof. An editor who recomputes the altered
receipt's hash, every following link, and the bundle hash produces a chain that
validates. The chain detects *unrecomputed* modification; it does not resist an
editor willing to redo the work. See
[What verifying a bundle does and does not prove](#what-verifying-a-bundle-does-and-does-not-prove).

## Bundle hash

```text
bundleHash = sha256Hex(canonicalJson(receipts))
```

The digest covers the **entire `receipts` array as it appears in the bundle**,
including each `receiptHash`. It does not cover `schemaVersion`, `workspaceId`,
`exportedAt` or `receiptCount`, so two exports of the same receipts at different
times carry the same `bundleHash`.

## Verification algorithm

A verifier receives only the bundle. Run all three checks; a bundle is valid only
if all three pass.

### 1. Bundle seal

```text
sha256Hex(canonicalJson(bundle.receipts)) == bundle.bundleHash
```

Detects modification of the receipts array that was not accompanied by
recomputing `bundleHash`. It does not detect an editor who rewrote the array and
resealed it.

### 2. Envelope version

Compute the expected version: `v4-receipt-bundle-v2` if any receipt has
`schemaVersion == "v4-receipt-v2"`, otherwise `v4-receipt-bundle-v1`. It must
equal `bundle.schemaVersion`.

### 3. Chain validation

Walk `receipts` in order. For each record at index `i`:

**a. Self-consistency.** Remove `receiptHash`, recompute
`sha256Hex(canonicalJson(rest))`, and compare with the stored `receiptHash`. A
mismatch means the record's stored hash does not match a recompute over its own
content — report `content_tampered` at `i`.

The label is the protocol's existing wire value and does not change. Read it as
*stored hash disagrees with recomputed hash*. It is not evidence of adversarial
tampering, and its absence is not evidence that the record is unchanged since
export: a rewritten-and-resealed record agrees with itself and reports nothing.

**b. Linkage.** For `i == 0`, `previousReceiptHash` must equal the genesis
marker, else report `genesis_mismatch`. For `i > 0`, it must equal
`receipts[i-1].receiptHash`, else report `chain_link_broken`.

A record that is not an object, or that is missing `receiptHash` or
`previousReceiptHash`, is `content_tampered` at its index.

Stop at the first failure and report the index. An empty array passes.

### What is deliberately not checked

**`receiptCount` is not a verification input.** It is informational. A bundle
whose `receiptCount` disagrees with `receipts.length` is still valid if the
three checks above pass, and a conforming verifier must not reject it on that
basis.

This is worth stating because rejecting it feels safer and is wrong. A verifier
that adds the check is stricter than the format, so it will reject bundles the
producer considers valid — which is a conformance defect, not extra safety. The
seal already covers the receipts array, so `receiptCount` cannot be used to hide
a modification: changing the array changes `bundleHash`.

Use this as a portability test. Take a valid bundle, change only
`receiptCount`, and verify it. A conforming implementation still reports valid.
If yours reports invalid, it has this defect.

**`exportedAt` is also not checked**, and is not covered by the seal, so two
exports of the same receipts at different times are both valid and share a
`bundleHash`.

## Worked example

`examples/receipt-bundle.valid.json` is produced by the real export path, not
written by hand. It carries three receipts and:

```text
bundleHash  be51f403d02405ccda37a6565180b88d662cdfe0f998b493ecfd77dabd317a84
chain       genesis:v4-receipt-chain -> 3c8bfe7d… -> c9a316f9… -> 2d672b6e…
```

Recomputing `sha256Hex(canonicalJson(receipts))` over that file must reproduce
the `bundleHash` above. If your implementation does not, the difference is almost
always key ordering or stray whitespace in `canonicalJson`.

That fixture is pure ASCII, so it cannot detect the serialization rules that
actually break portability. **`examples/receipt-bundle.unicode.valid.json` is the
one to test against:**

```text
bundleHash  2c99919effcb1b4c3d3ae91f4114ee19683768e887792ee3de194c1d02560dee
```

It is also produced by the real export path, and its `metadata` deliberately
exercises every rule above:

| Content | Rule it falsifies |
| --- | --- |
| Turkish text (`kullanıcı onayı geçti`, `şüpheli değil`) | non-ASCII must stay literal, not `\uXXXX` |
| keys `U+E000` and `U+1F600` in one object | UTF-16 code-unit ordering, not code-point ordering |
| `1e-7`, `5e-7`, `1e-9` | exponent without zero padding |
| `0.00001`, `0.000001` | plain decimal above the `1e-7` threshold |

An implementation that reproduces the ASCII fixture but not this one has all
three of the common defects and would reject genuine bundles. Test against this
file before claiming conformance.

Two negative examples each differ from the valid one by exactly one JSON leaf:

| Example | Mutated leaf | Fails |
| --- | --- | --- |
| `receipt-bundle.tampered-bundle-hash.json` | `bundleHash` | check 1 only; the chain still validates |
| `receipt-bundle.broken-chain.json` | `receipts[1].decision` | check 3a `content_tampered` at index 1, **and** check 1 as a consequence |

The second is worth understanding rather than memorizing. Changing one canonical
field breaks that receipt's own hash *and* the bundle seal, because the seal
covers the receipts array. That redundancy is deliberate, not an accident:
whoever repairs one must still repair the other, and repairing the receipt hash
breaks the link the following receipt committed to. What it buys is cost, not
prevention — an editor who works through the whole chain produces a bundle that
verifies.

## What verifying a bundle does and does not prove

It proves the bundle is **internally consistent**: every receipt hashes to its
recorded value, every link matches its predecessor, and `bundleHash` matches the
receipts array as it stands. Equivalently, it detects any modification that was
not accompanied by recomputing the affected hashes.

It does **not** prove the bundle is unchanged since export. The format is
unsigned and self-contained, and carries no externally anchored head, so nothing
in it is beyond an editor's reach. Change a receipt, recompute its hash, recompute
every following link, recompute `bundleHash`, and the result verifies. The three
checks are satisfied because the document now agrees with itself — which is all
they ever measured.

Nor does it prove the receipts describe events that actually happened, that the
exporting system was honest, or that the bundle came from any particular party.
There are no signatures here; nothing binds a bundle to an issuer identity.

What the assurance actually decomposes into:

| Question | Answered by |
| --- | --- |
| Is this document self-consistent? | the three checks in this specification |
| Was it modified without resealing? | the three checks |
| Was it modified *and* resealed? | **nothing in this format** |
| Who issued it? | **nothing in this format** |
| Does it match what the issuer holds? | comparing `bundleHash` against a value obtained from the issuer through a separate channel |

Only the last row survives an editor able to recompute, and it works because the
comparison value comes from outside the document. A recipient who needs that
guarantee must obtain the hash independently; a hash carried inside the artifact
cannot supply it.

Anyone building on this should hold that line explicitly. Treating chain validity
as proof of authenticity, or as proof that nothing changed after export, is the
most likely way to misuse this format.
