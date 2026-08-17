# V5 Verification Core — Source-Reality and Promotion Gate

**Status:** `contract`

**Parent issue:** #847

**Child issue:** #872

**Mode:** Source-reality and promotion-gate decision only. No production wiring.

**Canonical base:** `main @ bcd36beb7bcae936c0240297fe061a811eac74e5`

## Decision

`lib/v5/verification-core.js` is a tested, pure V5 library module, but it is **not production-reached** at the canonical base. The existing production A2A exchange path does not import it. The cryptographic adapter is production-reached and the adapter/core handoff is covered by tests, but a test import is not a production caller.

The source-reality decision is therefore:

```text
NO_REAL_CALLER_YET
```

The module must remain in `lib/module-reachability.js::NOT_YET_WIRED`. This child does not remove or alter that acknowledgement, and it does not add a speculative caller merely to shorten the list.

## Why this is the first bounded unit

The verification core is the clearest first unit in the #847 decomposition. It has one public evaluation entry point, no internal module dependencies, direct fixture ownership, and explicit isolation tests. That evidence is strong enough to define a promotion gate without pretending that the evidence plane, Route Receipt writer, durable store, or replay path already exists.

The choice is not a caller-selection decision. It answers the narrower source-reality question: **what must be true before a production surface may honestly consume this module?** A later implementation child must name the caller, authority boundary, transaction owner, and focused integration tests before any reachability entry can change.

## Current source contract

`lib/v5/verification-core.js` exports the following public surface:

| Export | Current responsibility | Production meaning |
|---|---|---|
| `SUPPORTED_SCHEMA_VERSION` | Identifies the bounded writer-input schema version. | A caller must supply this exact contract version. |
| `SUPPORTED_ALGORITHM` | Identifies the only currently accepted structural algorithm label. | A caller must not infer support for another algorithm. |
| `normalizeCryptographicVerificationEvidence` | Accepts a canonical adapter-shaped evidence result and returns a fresh normalized object, or a deterministic malformed result. | This is a handoff normalizer, not a cryptographic verifier. |
| `evaluateBoundedVerification` | Evaluates bounded input shape, claims, key metadata, payload identity/digest consistency, algorithm and signature evidence. | It returns verification status only; it does not establish trust or authorization. |

The evaluation input is an object containing a supported `schemaVersion`, supported `algorithm`, a bounded `payload`, a non-empty `signature`, a non-empty `keyReference`, bounded `trustedKeyMetadata`, an ISO-parsable `evaluationTime`, and optional `claims`. The payload contract includes canonicalization, payload identity, content reference and digest fields. Optional signed-payload and expected-digest fields must agree with their canonical counterparts.

The output is intentionally small and serializable:

```json
{
  "verificationStatus": "verified | not_verified",
  "reasonCategory": "signature_valid | <bounded failure reason>"
}
```

A `verified` result means only that this bounded verification contract accepted the supplied evidence. It does not mean the package is trusted, the action is authorized, the content is safe, or execution is approved.

## Fail-closed behavior

The core returns `not_verified` for malformed input, missing or synthetic signature evidence, unsupported algorithms, payload identity mismatch, payload digest mismatch, unknown/revoked/expired/unavailable/malformed key metadata, forbidden claims, and malformed cryptographic handoff results. It rejects secret or network material in trusted-key metadata and does not treat claims such as `packageTrust`, `actionAuthorization`, or `externalExchange` as verification evidence.

The test contract also proves that the module does not access the network or system clock, does not mutate caller input, produces deterministic repeat results, and does not expose trust or authorization fields in its output. These are properties of the current bounded library contract; they are not evidence of production enforcement.

## Production caller audit

The only currently graduated V5 production path is the bounded A2A exchange route:

```text
POST /api/a2a/exchange
  -> lib/a2a/exchange-route.js
  -> lib/a2a/bounded-exchange.js
```

At the canonical base, `lib/a2a/bounded-exchange.js` imports the cryptographic profile contract, cryptographic verification adapter, public trust receipt importer and trusted-key resolver. It does **not** import `lib/v5/verification-core.js`, `lib/v5/runtime-reader.js` or `lib/v5/runtime-writer.js`.

`lib/v5/cryptographic-verification-adapter.js` is therefore negative evidence for transitive reachability: it is a real production module, but it is a separate implementation and does not require the verification core. The tests intentionally import both modules to verify the handoff normalizer. That test relationship cannot graduate the core.

The current reachability ledger records the core as:

```text
lib/v5/verification-core.js:
  V5 library implementation; entry authorized, no production caller yet
```

This is the correct classification. Removing the line would make the ledger less truthful, not more complete.

## Promotion gate for a later implementation child

A future child may promote the core only after all of the following are explicit and testable:

| Gate | Required evidence |
|---|---|
| Caller ownership | A named production entry point imports and invokes the core on a real bounded path. |
| Authority inputs | The caller identifies which fields are authoritative and prevents untrusted request data from self-asserting trust, authorization or exchange claims. |
| Verification handoff | The caller supplies cryptographic evidence from the separately governed adapter or an explicitly approved equivalent; the core is not treated as the cryptographic primitive. |
| Contract compatibility | The integration preserves the current V5 schema, reason vocabulary and output non-claims. |
| Persistence boundary | If a receipt or evidence record is emitted, the storage owner and transaction boundary are named; no partial mutation may be observable. |
| Fail-closed integration | Caller, resolver, adapter, storage and downstream write failures produce a deterministic refusal and no partial admission. |
| Focused tests | Tests cover a real production invocation, valid evidence, malformed evidence, authority-claim smuggling, caller failure and no-partial-write behavior. |
| Reachability proof | `test/module-reachability.test.js` passes because the real caller reaches the module, not because the ledger entry was deleted. |

Until these gates are satisfied, the correct result is `NO_REAL_CALLER_YET` and the core remains a library-only capability.

## Explicit non-claims

This document does not claim that a V5 durable evidence store, transactional outbox, replay tool, Route Receipt write contract, source snapshot, graph-mutation atomicity, connector enforcement or external verifier exists. It does not claim that the A2A exchange route uses the verification core. It does not claim that a verified signature implies trust, authorization, safety or approval for execution.

It also does not select a production caller. Selecting or implementing that caller requires a separate child issue with a named entry point, authority model, storage owner, transaction boundary, rollback behavior and integration tests.

## Validation

This docs-only decision preserves the existing source and reachability contracts. The focused validation commands are:

```bash
node --test test/module-reachability.test.js test/v5-verification-core.test.js
git diff --check
```

The first command must continue to prove both that the core remains explicitly acknowledged as unreached and that its 15-fixture, deterministic, fail-closed contract remains green.

## Exit criteria for #872

#872 may close after this document is merged and the issue records the following facts:

1. The canonical base SHA and source exports are recorded.
2. The current input/output and fail-closed contract is source-backed.
3. The existing A2A/adapter path is classified as insufficient to graduate the core.
4. The promotion gates and stop condition are explicit.
5. `NOT_YET_WIRED` remains unchanged.
6. The focused reachability and verification-core tests pass.

Closing #872 does not close #847. The parent remains open for separately scoped production-caller, package-write, source-snapshot, atomicity, outbox and replay children.

## References

- [`lib/v5/verification-core.js`](../../lib/v5/verification-core.js)
- [`test/v5-verification-core.test.js`](../../test/v5-verification-core.test.js)
- [`lib/a2a/bounded-exchange.js`](../../lib/a2a/bounded-exchange.js)
- [`lib/v5/cryptographic-verification-adapter.js`](../../lib/v5/cryptographic-verification-adapter.js)
- [`lib/module-reachability.js`](../../lib/module-reachability.js)
- [`test/module-reachability.test.js`](../../test/module-reachability.test.js)
- [`#847 — Durable evidence plane`](https://github.com/ali-ulu/huqan/issues/847)
- [`#872 — Verification-core source-reality and promotion gate`](https://github.com/ali-ulu/huqan/issues/872)
