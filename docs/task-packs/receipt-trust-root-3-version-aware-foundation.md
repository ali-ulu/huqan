# RECEIPT-TRUST-ROOT-3 - Version-Aware Foundation

## Plan Check

- Repository: `ali-ulu/huqan`
- Scope-definition base: `main @ 60120ee76e835498c3e3aa5b244896ae31416432`
- Required implementation base: exact post-merge canonical `main` authorized after this task-pack closes
- Predecessors: `ADR-008`, `ADR-009`, `RECEIPT-TRUST-ROOT-2`
- Mode: implementation scope definition
- Production v2 writer: forbidden
- Durable family-scoped chain migration: deferred to `RECEIPT-TRUST-ROOT-3A`

## Decision

This gate may implement deterministic V2 canonical building, validation,
materialized read dispatch, and V4 export verification. A pure builder is not
a writer. Every durable production write of a V2 canonical payload remains
fail-closed until a later gate names an authoritative trust-root owner.

V4 export must reject mixed receipt families. It must never filter, relabel,
invent a genesis record, or present an incomplete family view as a valid V4
bundle.

## Allowed Runtime Files

```text
lib/receipt/canonical-receipt-v2.js
lib/receipt/v4-receipt-family.js
lib/receipt/receipt-read-index.js
lib/receipt/receipt-export.js
graph.js
```

Allowed test ownership:

```text
test/receipt-trust-root-v2-runtime.test.js
```

Existing receipt and reviewed-external tests are read-only regression owners.

## Required Interfaces

`canonical-receipt-v2.js` owns:

```text
CANONICAL_RECEIPT_V2_SCHEMA_VERSION = v4-receipt-v2
TRUST_ROOTS = local_operator | external_verified_client
buildCanonicalReceiptPayloadV2(receipt, { verdict, trustRoot })
validateCanonicalReceiptV2(payload)
classifyRawMaterializedReceipt(raw)
```

The V2 builder must reuse the V1 projection rather than copy it. It accepts
`trustRoot` only from its options object and never from receipt fields,
metadata, actor, source, transport, workspace, or signature presence.

Canonical V2 validation uses an exact top-level allowlist equal to the V1
canonical payload keys plus `trustRoot`. Raw materialized receipt validation is
a separate projection boundary. A discriminator-free raw receipt follows the
unchanged V1 projection and receives no new own-key policy. Only a raw receipt
that declares `canonicalReceiptSchemaVersion: v4-receipt-v2` is subject to the
exact V2 raw own-key, descriptor, and trust-root checks. For declared V2,
inherited, symbol, non-enumerable, unknown, nested, malformed, or missing
authority fields fail closed.

`v4-receipt-family.js` owns V4-family classification, version-aware chain
validation, and the durable-write guard. Generic chain hashing and validation
remain unchanged.

## Bounded Error Vocabulary

This task-pack authorizes exactly these new codes:

```text
V4_RECEIPT_V2_WRITE_NOT_ENABLED
UNSUPPORTED_RECEIPT_SCHEMA_VERSION
INVALID_TRUST_ROOT
V4_CHAIN_VERSION_REGRESSION
RECEIPT_BUNDLE_MIXED_FAMILY
```

No additional status, error, schema, verdict, decision, or trust-root value may
be introduced in the implementation gate.

## Durable Write Guard

`Graph.runMutationOnce()` must validate the payload immediately after the
receipt callback and before chain append or database insertion:

- existing V4 V1 payload: allowed unchanged;
- V4 V2 or later V4 payload: reject with
  `V4_RECEIPT_V2_WRITE_NOT_ENABLED`;
- existing non-V4 receipt family: preserve unchanged.

The rejection must roll back the mutation, journal entry, receipt row, and
in-memory Graph state. No production callsite is authorized to bypass or
disable this guard in this gate.

## Read Contract

- no raw discriminator: unchanged V1 projection;
- exact `canonicalReceiptSchemaVersion: v4-receipt-v2` plus a valid top-level
  trust root: V2 projection;
- declared V2 with invalid or missing root returns exactly
  `error: { code: 'INVALID_RECEIPT', causeCode: 'INVALID_TRUST_ROOT', message }`;
- unknown discriminator returns exactly
  `error: { code: 'INVALID_RECEIPT', causeCode: 'UNSUPPORTED_RECEIPT_SCHEMA_VERSION', message }`;
- no downgrade, inference, input mutation, or fabricated V1 trust root.

Existing public read status and primary error-code vocabulary remain unchanged.
The additive `error.causeCode` field is authorized only for these two bounded
V2 read failures and must not appear on existing V1 responses.

## Export Contract

- V1-only V4 input remains byte-compatible bundle V1;
- a validated chronological V4 chain containing V2 selects bundle V2;
- any non-V4 record in a V4 export request rejects with
  `RECEIPT_BUNDLE_MIXED_FAMILY`;
- unsupported receipt/bundle version, invalid trust root, version regression,
  array tamper, record reorder, or historical rewrite fails closed;
- generic journal validation and reviewed-external receipt behavior remain
  unchanged.

Receipt-family classification may use the declared canonical field boundary:
V4 has a supported `schemaVersion`; existing reviewed-external records use
their separate `version` field. Classification is for validation/export only
and does not claim durable family-scoped predecessor selection.

## Required Tests

The new runtime test consumes the existing 35 fixtures and turns eligible V2
structural cases into executable validation without modifying the fixture
corpus or its contract test. It must prove:

- V1 golden bytes, hashes, chain, and bundle remain unchanged;
- both V2 roots validate and every malformed variant fails closed;
- caller receipt fields and metadata cannot self-declare authority;
- V1 to V2 chronology validates without predecessor rehash;
- V2 to V1 regression and every tamper variant fail;
- mixed-family export rejects rather than filters;
- a V2 durable write leaves zero mutation, journal, and receipt state;
- reviewed-external generic journal behavior remains green;
- reader/exporter defensive copies and source immutability remain intact.

Required commands:

```text
node --test test/receipt-trust-root-v2-runtime.test.js
node --test --test-concurrency=1 test/receipt-trust-root-contract.test.js test/receipt-trust-root-v2-runtime.test.js test/v4-trust-receipt-primitive.test.js test/v4-receipt-materialization-read-index.test.js test/durable-mutation-journal.test.js test/reviewed-external-graph-execution.test.js test/reviewed-external-graph-execution-integrity.test.js test/v4-wb1-trust-receipt-inspector.test.js
npm test
git diff --check
git status --short
```

## Forbidden Scope

```text
kernel.js
mcpServer.js
server.js
cli.js
lib/sdk.js
lib/receipt/canonical-receipt.js
lib/receipt/receipt-chain.js
lib/reviewed-external-graph-execution.js
database schema or migration
family-scoped predecessor selection
writer ownership or callsite migration
external endpoint
historical rehash or backfill
dependency or package changes
```

## Stop Conditions

Stop if implementation requires a sixth error code, a third trust root, a new
public status, mutation of V1 bytes, silent mixed-family filtering, durable
schema migration, trust-root inference, an existing writer version change, or
changes outside the allowed files.

## Non-Claims

This foundation does not prove or enable a production V2 writer, durable
family-scoped chains, writer ownership, external-client enforcement, an
external endpoint, historical trust-root classification, universal receipt
coverage, ecosystem readiness, or V5 completion.

## Successor

`RECEIPT-TRUST-ROOT-3A` separately decides durable family-scoped predecessor
semantics and authoritative writer ownership. It requires schema-migration and
adversarial SQLite evidence and is not authorized by this task-pack.
