# Open-standard interop: W3C VC + OpenTelemetry (#1911)

HUQAN public trust receipts (`v5-public-trust-receipt-v1`,
`specs/huqan-trust-protocol/0.2/schemas/public-trust-receipt.schema.json`)
project onto two open standards with zero vendor SDK dependency. Both
mappings are pure functions in `lib/interop/` and are re-exported from the
package root (`index.js`): `publicReceiptToCredential`,
`credentialToPublicReceipt`, `publicReceiptToSpan`, `toOtlpHttpPayload`.

## W3C Verifiable Credentials v2.0 (`lib/interop/vc-mapping.js`)

| HUQAN field | VC field |
|---|---|
| `publicReceiptId` | credential `id` (`urn:huqan:public-receipt:<id>`) |
| fixed types | `type: ["VerifiableCredential", "HuqanTrustCredential"]` |
| signature `keyId` | `issuer.id` (`https://huqan.dev/keys/<keyId>`) |
| `issuedAt` | `validFrom` |
| 7 allowlisted disclosure fields | `credentialSubject` (+ subject `id` from `binding.internalReceiptHash`) |
| full receipt | `evidence[0]` (`HuqanPublicReceipt`, lossless round-trip) |
| Ed25519 signature | `proof` of type `HuqanEd25519Signature2020` (see below) |

Proof honesty: the HUQAN signature covers the domain-separated projection
`HUQAN/V5/PUBLIC-TRUST-RECEIPT/v1`, not the credential document, so the
proof uses a HUQAN-specific type and names the projection plus a note
pointing at `importPublicTrustReceipt` (`lib/receipt/public-trust-receipt.js`).
A standard `Ed25519Signature2020` proof is never emitted. Verification always
re-enters the HUQAN import path (checksum, independent receipt/bundle
binding, trusted key resolution).

Tamper evidence: the mapping refuses material it cannot vouch for, raising
`VC_TAMPERED` — a code kept distinct from `VC_INVALID_*` because the document
is well formed, which is what makes it dangerous.

- **A receipt edited behind its own checksum** is structurally perfect, so
  shape checks alone would let the envelope launder it into standard tooling.
  The receipt checksum is verified in both directions.
- **An edited `credentialSubject` beside an untouched `evidence` receipt**
  produces a credential that verifies and lies at the same time: read the
  subject and you see one verdict, re-run the import path and you see another.
  The evidence receipt is authoritative, divergence is refused, and the error
  names the field that diverged so an auditor learns what was changed rather
  than only that something was.

The checksum is keyless. It catches corruption and casual edits, not an editor
who recomputes it; authenticity still rests on the signature check.

## OpenTelemetry traces (`lib/interop/otel-mapping.js`)

| HUQAN field | OTel span field |
|---|---|
| `binding.internalReceiptHash` | `traceId` (128-bit) |
| `publicReceiptId[0:16]` | `spanId` (64-bit) |
| `receiptKind` + `verdict` | `name` (`huqan.trust.<kind>.<verdict>`) |
| `createdAt` / `issuedAt` | `startTimeUnixNano` / `endTimeUnixNano` |
| disclosure fields | `huqan.*` attributes (no actor/reason/metadata) |
| `verdict` | `status` (`block`/`quarantine`/`disabled` → ERROR) |

`toOtlpHttpPayload` wraps spans in an OTLP/HTTP `TracesData` payload
(`service.name` defaults to `huqan`) that can be POSTed to any OTLP receiver.

## Non-goals

- No DIDs are minted: key references stay HUQAN-scoped URLs.
- No unlinkability is claimed: `publicReceiptId` and
  `binding.internalReceiptHash` are stable correlators (see
  `public-receipt-redaction-policy.json`, `receiptIdDecision`).
- Full chain re-validation stays in `verify_bundle.py`
  (`specs/huqan-trust-protocol/0.2/conformance/`), not in these mappings.
