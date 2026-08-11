# V5-D3 Public Trust Receipt Exchange

## Status

`V5_D3_PUBLIC_TRUST_RECEIPT_PROVEN`

This gate adds a library export/import surface for the distinct public receipt
format authorized by V5-C4. It does not add an HTTP route, CLI command, MCP
tool, key-distribution service, or production caller.

## Export contract

`exportPublicTrustReceipt()` accepts one self-consistent V4 receipt, a
canonical `issuedAt`, and an Ed25519 private `KeyObject`. If a source receipt
bundle is supplied, the existing `verifyExportedBundle()` verifier must accept
it and the selected receipt must occur in it.

The exporter constructs `disclosure` only from the seven fields in
`public-receipt-redaction-policy.json`. It never copies an internal object and
then deletes fields. A newly added internal field is therefore withheld by
default. If an allowlisted value looks like a secret, export fails; it is not
silently scrubbed and re-signed.

The signature message is the `json-stable-v1` encoding of exactly:

```text
domainLabel = HUQAN/V5/PUBLIC-TRUST-RECEIPT/v1
schemaVersion
publicReceiptId
issuedAt
disclosure
binding
integrity.checksumAlgorithm
integrity.signed = true
integrity.signature.profileId
integrity.signature.keyId
```

`integrity.checksum` and `integrity.signature.value` are excluded from the
signature message. After signing, the checksum is computed over the final
artifact with only `integrity.checksum` removed. The checksum therefore covers
the signature bytes. This ordering has no circular field dependency.

## Import and verification order

Import is fail-closed in this order:

1. accept at most 1 MiB of valid UTF-8 bytes;
2. require byte-for-byte `json-stable-v1` canonical form, rejecting duplicate
   keys, alternate key order, whitespace and trailing data;
3. require the exact public receipt shape and the machine policy allowlist;
4. verify the keyless checksum before reading trusted-key records;
5. compare `binding.internalReceiptHash` with the caller's independently
   supplied expected hash;
6. when `bundleHash` exists, compare it with an independently supplied hash or
   an independently verified source bundle containing the receipt;
7. require a signed artifact, resolve key lifecycle at `evaluationTime`, and
   require an active unique Ed25519 key;
8. verify the domain-separated Ed25519 signature.

An unsigned C4 document remains schema-valid, but the D3 importer returns a
rejected result and never labels it verified. A checksum is self-consistency,
not authenticity. A self-asserted receipt or bundle hash is not an independent
binding.

## File boundary

`writePublicTrustReceiptFile()` writes canonical bytes with exclusive `wx`
creation and mode `0600`; existing targets are unchanged. The parent must
already be a real directory, not a symlink or junction. Reads reject symlinked
targets and enforce the same byte bound before parsing.

The library does not claim to defend against an operating-system adversary
that replaces an already checked parent directory between the path check and
the open call. Consumers needing that stronger property must provide a
directory-handle-based platform boundary.

## Evidence and non-claims

The D3 test uses real Ed25519 keys and independent Node processes for the file
round-trip. Adversarial cases cover source tampering, default-deny disclosure,
secret-looking values, checksum resealing versus signatures, key substitution,
key lifecycle boundaries, independent bindings, canonical input, file races,
symlinks and defensive copies.

This proves a bounded library exchange primitive. It does not prove external
interoperability, production reachability, key distribution, network delivery,
or public receipt revocation.
