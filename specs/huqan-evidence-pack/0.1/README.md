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
`nonClaims` array, and `README-AUDITOR.md` (a later slice) restates them for a
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

A manifest entry names a canonical, relative, forward-slash path. An absolute
path, a backslash, a `.` or `..` segment, or a non-normalized form is rejected as
`manifest_path_invalid` before any file is opened, so no entry can name a file
outside the pack. The two verifiers apply this policy identically.

A directory that fails any check is reported INVALID and the exit status is 1.
There is no partial verdict and no "mostly valid".
