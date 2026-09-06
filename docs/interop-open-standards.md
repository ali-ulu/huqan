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
