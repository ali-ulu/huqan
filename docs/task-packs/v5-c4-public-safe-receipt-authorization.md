# V5-C4 — Public-Safe Trust Receipt: Authorization

## Status

`AUTHORIZED_FOR_SCHEMA_AND_FIXTURES`

Schema, redaction policy and fixtures only. No runtime wiring, no export route,
no production caller, no signing implementation. Entry unblocked: issue #276's
sole recorded blocker is `V5-C1 PASS`, and #273 is closed.

## The decision that shapes everything else

**A public receipt is a distinct artifact that references an internal receipt.
It is not a redacted copy of one.**

This is forced by source, not preference. The V4-B3 authorization recorded it
already:

> canonical receipt content including `metadata` participates in the hash
> semantics that `verifyExportedBundle()` checks, so removing fields during a B3
> export would either break chain validation or amount to defining a new public
> receipt format.

`receiptHash` is computed over the whole canonical payload plus
`previousReceiptHash`. Drop `metadata`, or blank `reason`, and the receipt no
longer hashes to its recorded value — the chain reports `content_tampered`. A
"redacted receipt" that fails verification is worse than useless: it teaches
consumers that verification failures are normal.

So C4 defines a **new format** that carries its own integrity, plus hashes
binding it to the internal receipt it summarizes. Redaction becomes a
construction rule for that format, not a subtraction from an existing one.

## Source-reality: signing does not exist yet

Issue #276 requires a `Signature/checksum` field. What exists today:

- `lib/v5/cryptographic-profile-contract.js` declares profile `ed25519-v1` with
  `ed25519-spki-der` and `ed25519-raw` representations — a **contract**;
- `lib/v5/verification-core.js` accepts exactly one algorithm,
  `test-structural-v1`, and only signatures matching
  `/^synthetic-signature-placeholder:v1:case-\d{2}$/` — a **test harness**;
- issue #435 is open against precisely that placeholder;
- every `lib/v5/*` module is in `NOT_YET_WIRED`.

There is therefore no signing implementation, and C4 must not pretend otherwise.

**Binding consequence.** The integrity field that C4 makes *mandatory* is a
keyless **content checksum**. A signature block is defined as *optional* and
contracted against `ed25519-v1`, but:

- no fixture may carry a synthetic placeholder in a field presented as a real
  signature;
- an unsigned public receipt must be structurally distinguishable from a signed
  one, never merely absent-by-omission;
- no acceptance criterion may be satisfied by `test-structural-v1`.

A checksum proves the document was not altered. Only a signature would say who
issued it, and C4 does not deliver that. Conflating the two is the single most
likely way this format gets misused, and the schema must make the difference
visible rather than rely on documentation.

## Leak surface the redaction policy must cover

Canonical receipt fields, classified by why they cannot travel:

| Field | Why it must not appear publicly |
| --- | --- |
| `workspaceId` | tenancy identifier; reveals who the receipt belongs to |
| `actor`, `agentId` | actor identity |
| `admissionId`, `memoryDraftId`, `provenanceId`, `approvalId` | internal correlation ids, joinable across receipts |
| `reason` | free text written by the runtime; unbounded content |
| `metadata` | arbitrary object; the highest-risk field by construction |

Fields that may travel because they carry decision shape rather than content:
`schemaVersion`, `receiptKind`, `decision`, `verdict`, `status`, `riskScore`,
`trustPolicyVersion`, `createdAt`.

`receiptId` is deliberately **undecided** and must be settled by the
implementation with a written justification: it is a stable handle useful to a
recipient, and simultaneously a correlator across disclosures. Either choice is
acceptable; choosing silently is not.

## Required schema shape

### 1. Public/internal boundary

The format declares its own `schemaVersion`, distinct from `v4-receipt-v1`, so a
public receipt can never be mistaken for or validated as an internal one. A
public receipt is not accepted by internal receipt validation, and an internal
receipt is not accepted as public.

### 2. Redaction policy

Declarative and machine-checkable: an allowlist, not a denylist. A field absent
from the allowlist is excluded, so a new internal field added later cannot leak
by default. The policy is data the test can read, not prose only.

### 3. Evidence binding

Minimum hashes proving the public receipt corresponds to a real internal
receipt: the internal `receiptHash`, and where applicable the `bundleHash` of a
bundle containing it. A recipient can compare these against a bundle they hold
without learning the redacted content.

### 4. Integrity

Mandatory keyless `checksum` over the public receipt's own canonical form,
using the serialization already specified in
`specs/axiom-trust-protocol/0.1/RECEIPT-BUNDLE.md` — sorted keys, no
whitespace, literal non-ASCII, ECMAScript number form. Reusing that rule is
required; defining a second canonicalization is a stop condition.

Optional `signature` block contracted against `ed25519-v1`, with the
unsigned/signed distinction structural.

## Required fixtures

1. **valid public receipt** — derived from a real internal receipt;
2. **round-trip** — export then import reproduces the same document and
   checksum;
3. **checksum mismatch** — fails closed;
4. **leak: `workspaceId` present** — rejected;
5. **leak: `metadata` present** — rejected;
6. **leak: free-text `reason` present** — rejected;
7. **unknown field present** — rejected by the allowlist, proving default-deny;
8. **evidence binding missing or wrong `receiptHash`** — rejected;
9. **unsigned** — valid, and structurally marked unsigned rather than silently
   lacking a signature.

Every negative fails closed. A fixture that warns is a stop condition.

## Falsification

Take a real internal receipt, apply the redaction policy, and hash the result
with the internal receipt's own rule. It must **not** equal the internal
`receiptHash`.

If it does, the public format is a subset of the internal one rather than a new
artifact, the B3 finding above has been contradicted, and the correct outcome is
`V5_C4_PUBLIC_SAFE_RECEIPT_BLOCKED_GAP` rather than a wider schema.

## Forbidden

- No change to the internal canonical receipt, its `schemaVersion`, chain or
  bundle format. C4 adds a format; it does not migrate one.
- No signing implementation, key management, key distribution or trust root.
- No use of `test-structural-v1` or synthetic placeholder signatures as evidence
  for any acceptance criterion.
- No second canonicalization rule.
- No export route, CLI, MCP or production caller.
- No dependency.
- No change to `lib/`, `graph.js`, `kernel.js`, `server.js`, `storage.js`,
  `plugins/` or `package.json`. If a validator module would require an entry in
  `lib/module-reachability.js`, put validation in the test instead — the same
  containment V5-C3 used.
- No claim that public receipt exchange is implemented, reachable or proved.

## Acceptance evidence

1. public `schemaVersion` distinct; cross-acceptance impossible in both
   directions;
2. redaction policy is machine-readable and default-deny;
3. none of the leak-surface fields can appear in a valid public receipt;
4. evidence-binding hashes present and checked;
5. checksum mandatory, computed with the RECEIPT-BUNDLE canonicalization;
6. signature optional, contracted, and no fixture presents a placeholder as
   real;
7. unsigned is structurally distinguishable from signed;
8. all nine fixtures exist and every negative fails closed;
9. falsification executed and recorded;
10. targeted tests and full `npm test` pass on the exact head.

Verdict, exactly one:

```text
V5_C4_PUBLIC_SAFE_RECEIPT_SUFFICIENT
V5_C4_PUBLIC_SAFE_RECEIPT_BLOCKED_GAP
```

## Non-claims

Closing C4 proves a schema, a redaction policy and fixtures. It does not prove
that a public receipt was ever exported by the runtime, that anyone received
one, or that its issuer can be identified.

The authorship question stays open by design. A checksummed public receipt is a
tamper-evident summary, not an attestation of who produced it. Real signing is
issue #435's territory and a later gate; until then, no material may describe a
public receipt as proving origin.

`V5_IMPLEMENTATION_ENTRY: FAIL` is unchanged. C5 (#277) remains blocked on
external interoperability evidence.
