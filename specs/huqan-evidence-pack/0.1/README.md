# HUQAN Evidence Pack 0.1

An evidence pack is a directory an operator hands to an auditor: the trust
artifacts a period produced, plus a manifest that binds them, so the auditor can
re-verify the directory with a tool that shares no code with the producer.

Protocol version `0.1` identifies this publication lineage. It does not claim
that the product is complete, and it is not a conformance level.

## What a pack is, and what it is not

A pack is **supporting evidence for a control**, never a statement that the
control was met. HUQAN does not issue a SOC 2 report, does not certify anything,
and a valid pack does not say a control is satisfied, does not prove that the
recorded events happened, and does not prove that the operator is honest. What a
valid pack proves is narrow and exact: this directory is internally consistent,
no packed file changed after the manifest was written, and every trust chain the
pack carries re-walks to its genesis.

Those limits travel with the pack. `manifest.json` carries them in its
`nonClaims` array, and `README-AUDITOR.md` restates them for a
human reader, so a reader who never opens the manifest is still told.

## Directory layout

```
evidence-pack/
  manifest.json                    # the inventory and its packHash
  manifest.signature.json          # optional; issuer-key signature over packHash
  receipts/receipt-bundle.json     # the V4 bundle, byte for byte as exported
  receipts/issuer-seals.jsonl
  external-actions/receipts.jsonl
  external-actions/collector-seals.jsonl
  emergency-stop/ledger.jsonl
  audit/audit-events.jsonl
  config/security-invariants.md
  config/policy-seals.json
  backups/backup-index.json
  controls/control-matrix.json
  verification/producer-self-check.json
  README-AUDITOR.md
```

The layout is normative for the files it names; a pack that carries a subset is
still verifiable, and an extra file is a finding, not a convenience -- a pack
must contain exactly what its manifest lists.

## The manifest

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `huqan.evidence-pack.v1` |
| `period` | `{ from, to }`, the ISO-8601 window the pack covers |
| `generatedAt` | ISO-8601 timestamp of production |
| `workspaceId` | the workspace the pack was produced for |
| `producer` | `{ product, version, issuerKeyId }`; `issuerKeyId` is `null` for an unsigned pack |
| `files` | one entry per packed file: `{ path, sha256, bytes, integrityClass }` |
| `nonClaims` | what the pack does not assert, as strings |
| `packHash` | the hash below |

`integrityClass` records what a file's integrity rests on, so a reader is not
left to assume every file is equally tamper-evident:

| Class | Files | What backs it |
| --- | --- | --- |
| `hash_chained` | receipt bundle, emergency-stop ledger | a chain a third party can re-walk from genesis |
| `counter_sealed` | collector seals | a signature by a key the operator does not manage |
| `issuer_sealed` | issuer seals | a signature by the operator's issuer key |
| `snapshot_hash_only` | audit events, config, backup index | this manifest's own SHA-256, and nothing more |

### packHash

`packHash` is `SHA-256` over the canonical JSON of the manifest with `packHash`
and `signature` removed, so it can be recomputed from the manifest alone:

```
packHash = sha256Hex(canonicalJson(manifest without packHash, signature))
```

Canonical JSON is the algorithm `RECEIPT-BUNDLE.md` already defines: object keys
sorted by UTF-16 code unit, arrays in order, the same string and number escapes.
The pack does not redefine it.

## Producing a pack

```
huqan evidence pack --from <ISO> --to <ISO> --out <dir>
huqan evidence verify <dir>
```

`--from` and `--to` are inclusive instants. A date-only value means 00:00:00Z
of that day, so `--to 2026-01-31` ends the period at the start of 31 January;
pass `--to 2026-01-31T23:59:59.999Z` to include the whole day.

The producer runs on the installation's own host and makes no network call. It
writes a new directory (never into an existing one) through a temporary sibling
and a rename, so a refusal leaves no output. It packs only the `default`
workspace. The receipt bundle is the bounded export of the period's receipts
(at most 1024 receipts and 2 MiB; beyond that it fails closed with
`MAX_RECEIPTS_EXCEEDED` and writes nothing), written byte for byte after the
bundle verifier accepted those bytes. Content a hash binds (bundle, ledger,
issuer seals) is never redacted: a secret-looking value there refuses the pack
(`EVIDENCE_PACK_SECRET_DETECTED`). Files only this manifest hashes are scrubbed
of secrets; PII classes the egress gate sees are listed in the manifest
`piiTypes` and are reported, not removed.

Issuer seals are keyed by the receipt hash the graph stored at commit time, which
is not the re-chained `receiptHash` the bundle shows. `receipts/issuer-seals.jsonl`
therefore carries each seal as stored, found by `receiptId`; it does not claim
the seal's hash equals the bundle's.

## Independent verification

`verify_pack.py` is a clean-room, standard-library-only verifier. It reads only
the pack directory, makes no network call, and reuses `verify_bundle.py` for the
receipt bundle rather than re-implementing it.

```
python3 verify_pack.py <pack-dir>
```

Exit status is 0 only when every check passes, 1 otherwise. It prints each file
with its `integrityClass` and the checks the pack does not cover.

The checks are:

1. `manifest.json` parses, declares `huqan.evidence-pack.v1`, and lists `files`.
2. `packHash` recomputes to the declared value.
3. Every listed file is present, and its SHA-256 and byte length match the entry.
4. Every packed file (other than the manifest and its signature) is listed.
5. `receipts/receipt-bundle.json`, when present, passes the four bundle checks
   `RECEIPT-BUNDLE.md` defines.
6. `emergency-stop/ledger.jsonl`, when present, re-walks as a hash chain from
   genesis (below).
7. `manifest.signature.json`, when present, verifies (below). A manifest whose
   `producer.issuerKeyId` is set but which ships no signature file is invalid.

### The emergency-stop ledger

Each ledger line is a JSON object: `seq`, `prevHash`, `hash`, an `action` of
`stop`, `lift` or `integrity_violation`, and the rest of the record. The chain is
valid when, entry by entry from the first: `seq` equals the line index; `prevHash`
equals the previous entry's `hash` (`null` for the first); `hash` equals
`SHA-256` over the canonical JSON of the entry without `hash`, `seq` and
`prevHash`, plus `prevHash`; and `action` is one of the three above. A line that
is not a JSON object is a corrupt entry and fails the chain. The finding is
`emergency_stop_ledger_invalid:<reason>` with `ledger_unreadable_or_corrupt`,
`ledger_seq_gap`, `ledger_prevhash_mismatch`, `ledger_hash_mismatch` or
`ledger_invalid_action`. A hash chain cannot be cut by period, so the ledger is
packed whole, not filtered to the pack's period.

## The manifest signature

`manifest.signature.json` is optional and is not listed in `files`. It holds
`{schemaVersion: "huqan.evidence-pack-signature.v1", algorithm: "ed25519", keyId,
publicKeyPem, signature}` where `signature` is base64 ed25519 over the canonical
JSON of `{schemaVersion: "huqan.evidence-pack-signature.v1", packHash, period,
generatedAt}`. The payload carries its own `schemaVersion`, so it cannot be
replayed as a receipt-bundle signature. `keyId` is `ed25519:` plus the first 32
hex characters of SHA-256 over the DER SubjectPublicKeyInfo of `publicKeyPem`.

The verifier recomputes the payload from `manifest.json`, checks that `keyId`
derives from the file's public key (`signature_key_id_mismatch`), that it equals
`manifest.producer.issuerKeyId` (`signature_producer_key_mismatch`), and that the
signature verifies (`signature_invalid`). A malformed file is
`signature_format_invalid`; a missing file for a manifest that names a key is
`signature_missing`. A pack without the file and with `issuerKeyId: null` is
reported `signature: unsigned` and is not a failure.

The public key is inside the pack, so the signature proves origin (the holder of
that issuing key sealed this manifest), not independence: the key lives on the
operator host. Every signed verdict prints that limit.

A manifest entry names a canonical, relative, forward-slash path. An absolute
path, a backslash, a `.` or `..` segment, or a non-normalized form is rejected as
`manifest_path_invalid` before any file is opened, so no entry can name a file
outside the pack. The two verifiers apply this policy identically.

A directory that fails any check is reported INVALID and the exit status is 1.
There is no partial verdict and no "mostly valid".
