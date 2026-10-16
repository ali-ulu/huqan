# Portable Trust Receipt (P0-3)

Refs #2161 (public receipt shape), #2199 (receipt exporter), #2505 (blast-radius receipt justification).

Goal: a receipt HUQAN did not produce can still be HUQAN-compatible,
and anything HUQAN exports can be verified without HUQAN.

## Produce (without HUQAN)

1. Build receipts against `specs/huqan-trust-protocol/0.2/schemas/`.
2. Bundle them per `specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md`
   (`sealVersion`, `schemaVersion`, `receiptCount`, `receipts[]`).
3. Canonical JSON first: key order and UTF-8 bytes are part of the hash.

## Verify (without HUQAN)

```bash
python specs/huqan-trust-protocol/0.2/conformance/verify_bundle.py receipt-bundle.json
```

or:

```bash
huqan verify receipt.json
```

Public-safe sharing uses the `v5-public-trust-receipt-v1` shape
(`public-trust-receipt.schema.json`): decision shape travels,
internal content does not. A public receipt never validates as internal.

## Non-goals (this PR)

- No new crypto, no new receipt kind, no exporter change.
- Third-party Go/browser verifiers stay future work after this contract.
