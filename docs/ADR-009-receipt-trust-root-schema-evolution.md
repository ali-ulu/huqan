# ADR-009 - Receipt Trust-Root Schema Evolution

## Status

Accepted schema-evolution decision

Implementation status: Not started

## Context

ADR-008 separates local-operator authority from verified external-client
authority. Future receipts must expose that distinction without rewriting
historical evidence.

The current canonical receipt schema is `v4-receipt-v1`. Its deterministic
hash covers every serialized field. A chained record additionally hashes its
`previousReceiptHash`, and an exported bundle hashes the complete receipt
array. Adding a field to an existing record would therefore change its own
hash, break successor linkage, and change any bundle hash containing it.

The current materialized-receipt reader reconstructs v1 canonical payloads
through the v1 builder. The current bundle envelope is
`v4-receipt-bundle-v1`. Neither surface is authorized to reinterpret or
rewrite legacy evidence.

The Graph mutation journal is a shared hash/link primitive, not a V4-only
receipt store. It also persists separately versioned receipt families such as
reviewed-external graph receipts. Trust-root schema dispatch must therefore be
scoped to V4 canonical admission receipt read/export surfaces and must not
narrow the shared journal validator to V4 schemas.

## Decision

Trust-root-aware receipts use a new canonical schema:

```text
v4-receipt-v2
```

The v2 canonical payload requires exactly one `trustRoot` value from this
closed vocabulary:

```text
local_operator
external_verified_client
```

The value is supplied by the authoritative boundary that creates the receipt.
The canonical receipt builder does not infer it from actor names, source type,
transport, workspace, signature presence, or other metadata.

## Version Rules

1. Existing `v4-receipt-v1` payloads, chained records, hashes, exports, and
   stored materialized receipts remain byte-for-byte unchanged.
2. No v1 receipt is backfilled, upgraded in place, or rehashed.
3. Absence of `trustRoot` on a v1 receipt means only that the field was not
   represented by that schema. It must not be cryptographically asserted as
   either trust root.
4. Every newly produced v2 receipt requires an explicit valid `trustRoot`.
   Missing, unknown, malformed, or caller-invented values fail closed before
   the receipt is committed.
5. A v2 receipt keeps the existing canonical fields and adds `trustRoot` as a
   top-level canonical field. Nested metadata is not an alternative source of
   trust-root authority.
6. The v1 builder remains available for verifying or reconstructing historical
   v1 evidence. A separate v2 builder or an explicit version-dispatching
   builder may be selected by the implementation task-pack; silent version
   selection is forbidden.

## Materialized Receipt Discriminator

A future raw materialized receipt intended for v2 projection must contain both
of these top-level fields:

```text
canonicalReceiptSchemaVersion: v4-receipt-v2
trustRoot: local_operator | external_verified_client
```

Only an authoritative v2 receipt-producing callsite may set these fields. The
canonical v2 builder maps the discriminator to canonical
`schemaVersion: v4-receipt-v2` and includes the same validated `trustRoot` in
the hashed payload.

Existing raw materialized receipts have no such discriminator. Its absence is
interpreted only as a presentation state named `legacy_v1_unspecified`; that
label is not serialized into canonical evidence and is not a third trust-root
value. It does not prove `local_operator` authority.

A raw receipt that declares `canonicalReceiptSchemaVersion: v4-receipt-v2`
but omits a valid `trustRoot` is invalid. A future writer must not emit v2 raw
receipts without the discriminator, and a reader must not infer the version
from timestamps, actor names, source types, transport, or metadata.

## Trust-Root Ownership

| Value | Authorized source | Forbidden use |
| --- | --- | --- |
| `local_operator` | An explicitly local CLI or local-adapter boundary after its existing admission contract succeeds | Remote or external requests; fallback for missing external evidence |
| `external_verified_client` | The future external-client boundary after identity, workspace, signed package, trusted-key, freshness, and replay checks succeed | Local calls, unverified transports, or callers directly setting receipt fields |

Business payloads and external clients cannot self-declare their trust root.
The receipt writer accepts the value only from a trusted internal callsite
defined by the future implementation contract.

## V4 Chain Compatibility

The shared receipt-chain primitive hashes record content generically and can
preserve a link from a v2 receipt to the stored hash of a v1 predecessor. In a
V4-family read/export view, mixed-version chains are permitted only in
chronological append order:

```text
existing v1 records -> first v2 record -> later v2 records
```

The following are forbidden:

- converting a v1 record to v2 inside an existing chain;
- inserting a v2 record before or between historical v1 records;
- recomputing a predecessor hash to make a rewritten chain appear valid;
- downgrading a v2 record to v1;
- accepting an unsupported schema version because its hash happens to match.

The shared Graph journal continues performing generic hash/link validation for
all existing receipt families. It is not changed into a V4-only dispatcher.
V4-family read/export validation must first validate each supported V4 receipt
version's exact shape and then validate stored hashes and predecessor linkage.
Generic hash validity alone is not V4 schema validity.

Cross-family Graph journal export and a universal receipt-family dispatcher
are outside this decision. Existing non-V4 family validators and persistence
semantics remain unchanged.

## Read Compatibility

The future V4 version-aware read path must:

- reconstruct discriminator-free historical raw receipts through the unchanged
  v1 contract and report only `legacy_v1_unspecified` outside canonical bytes;
- dispatch v2 only when the raw materialized receipt explicitly declares
  `canonicalReceiptSchemaVersion: v4-receipt-v2`;
- reconstruct v2 only when `trustRoot` is present and valid;
- return an explicit invalid/unsupported result for unknown versions;
- return v1 receipts without fabricating a trust-root assertion;
- return v2 receipts with the exact committed trust root;
- never mutate stored receipt objects during read or migration.

Presentation layers may describe v1 as legacy evidence with an unspecified
trust root. They must not serialize that description back into the canonical
receipt or treat it as verified `local_operator` evidence.

## Export Compatibility

V4 bundles containing only historical v1 receipts remain
`v4-receipt-bundle-v1` and retain their existing bytes and bundle hash.

Any newly created export containing at least one v2 receipt uses:

```text
v4-receipt-bundle-v2
```

A V4 v2 bundle may contain the chronological v1-to-v2 transition of one valid
V4-family chain. Bundle verification must validate the declared outer bundle
version, each V4 receipt schema, the complete receipt-array hash, and chain
linkage. It must fail closed for unsupported versions, invalid trust-root
values, reordered records, or rewritten v1 evidence.

This decision does not authorize a V4 bundle to absorb other Graph journal
receipt families. Existing stored or previously exported v1 bundle bytes are
not regenerated. A new export naturally has fresh envelope metadata; that does
not authorize mutation of an existing exported artifact.

## Implementation Sequence

1. `RECEIPT-TRUST-ROOT-0` - this decision.
2. `RECEIPT-TRUST-ROOT-1` - fixtures and contract-test scope for v1 preservation,
   v2 positive/negative cases, mixed chains, readers, and bundles.
3. `RECEIPT-TRUST-ROOT-2` - executable contract fixtures and tests without
   runtime writer migration.
4. `RECEIPT-TRUST-ROOT-3` - minimal version-aware receipt implementation and
   internal callsite ownership.
5. `RECEIPT-TRUST-ROOT-4` - adversarial migration, chain, reader, and export
   tests.
6. `RECEIPT-TRUST-ROOT-5` - closeout audit before external endpoint work.

Each implementation gate must name exact writer callsites. Existing writers
continue producing v1 until a separately reviewed migration explicitly binds
their authoritative trust root.

## Stop Conditions

Stop if implementation would require:

- rewriting or rehashing any historical v1 receipt;
- inferring a trust root from untrusted receipt or request fields;
- adding a third trust-root value without a new decision;
- silently changing the schema version emitted by an existing writer;
- accepting unknown receipt or bundle versions;
- narrowing the shared Graph journal validator to V4 receipt schemas;
- changing persistence or validation semantics for an existing non-V4 receipt
  family;
- weakening chain, bundle, read-index, or materialization validation;
- changing verdict, decision, status, receipt ID, workspace, provenance, or
  approval semantics;
- enabling an external endpoint;
- changing CLI or local-adapter behavior in the schema-decision gate.

## Non-Claims

This ADR does not implement or prove:

- a v2 receipt writer, reader, chain validator, or bundle exporter;
- migration of any existing receipt-producing callsite;
- classification of any historical v1 receipt as `local_operator`;
- production external-client enforcement;
- an enabled external endpoint;
- trusted-key lifecycle, identity verification, or replay protection;
- universal receipt coverage;
- ecosystem or V5 completion.
