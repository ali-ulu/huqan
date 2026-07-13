# V5-VERIFICATION-25A5A Legacy Active Contract Reconciliation

## Status And Purpose

**Mode:** docs-only contract reconciliation

This later amendment resolves the conflict discovered while executing the
V25A5 resolver key-material binding taskpack. It changes no source, fixture,
test, schema, package, runtime, or MCP behavior. It defines the only allowed
future migration necessary to make the V25A key-material binding contract and
the earlier legacy resolver surface agree.

The V25A key-material binding contract has precedence over the obsolete
legacy expectation that a selected active record without `publicKeySpkiDer`
returns:

```js
{ keyState: 'active' }
```

That expectation is no longer canonical. A selected otherwise-active record
without valid bound public material must use the existing bounded malformed
result:

```js
{
  keyState: 'malformed',
  reasonCategory: 'malformed_trusted_key_record'
}
```

## Scope And Non-Goals

This amendment authorizes neither the V25A5 implementation nor a compatibility
mode. In particular, later work must not introduce an optional active-key mode,
legacy flag, resolver version argument, environment switch, hidden default
key, generated key, or caller-parallel public key input.

An active resolver result without selected-record key material recreates the
gap V25A closes. No fallback preserves it.

The resolver remains non-cryptographic. It does not import a key, parse DER,
invoke the adapter, verify a signature, decide package trust, authorize an
action, access a key store, or perform network, database, transport, A2A, or
connector work.

## Failure Audit

The frozen V25A5 patch was exercised against the unchanged legacy resolver
chain. The chain produced 37 passing and 14 failing tests. Every failed
assertion expected legacy `{ keyState: 'active' }` from an active record that
does not carry `publicKeySpkiDer`; the patched resolver correctly returned the
existing malformed result. No failure was unrelated to mandatory active key
binding.

| # | Source | Test | Old active input/expectation | Future classification |
| --- | --- | --- | --- | --- |
| 1 | `test/v5-trusted-key-resolver.test.js` | `executes all 12 fixtures with exact state and reason mapping` | Legacy fixture 01 has an active record without key material. | A: migrated valid active fixture |
| 2 | `test/v5-trusted-key-resolver.test.js` | `rejects impossible calendar dates without normalizing them` | Its valid control input is active without key material. | A: valid active-path test |
| 3 | `test/v5-trusted-key-resolver.test.js` | `rejects sparse and non-object record arrays before record selection` | Its valid control record is active without key material. | A: valid active-path test |
| 4 | `test/v5-trusted-key-resolver.test.js` | `handles zero, one, and multiple exact matches without precedence` | The one-match control expects active without key material. | A: valid active-path test |
| 5 | `test/v5-trusted-key-resolver.test.js` | `applies parsed expiry semantics for less, equal, and greater instants` | The after-expiry control expects active without key material. | A: valid active-path test |
| 6 | `test/v5-trusted-key-resolver.test.js` | `preserves inputs and produces deterministic bounded output` | The successful repeated input is active without key material. | A: valid active-path test |
| 7 | `test/v5-trusted-key-resolver.test.js` | `does not read the system clock or return forbidden output claims` | The valid control expects active without key material. | A: valid active-path test |
| 8 | `test/v5-trusted-key-resolver.test.js` | `does not mutate fixture objects and keeps handoff output bounded` | Legacy fixture 01 expects active without key material. | A: migrated valid active fixture |
| 9 | `test/v5-trusted-key-resolver-adversarial.test.js` | `null-prototype and frozen valid inputs remain bounded and usable` | The valid frozen record is active without key material. | A: valid active-path test |
| 10 | `test/v5-trusted-key-resolver-adversarial.test.js` | `strict timestamps reject normalization and accept a real leap day` | The valid leap-day control is active without key material. | A: valid active-path test |
| 11 | `test/v5-trusted-key-resolver-adversarial.test.js` | `expiry remains instant-based at before, equal, and after boundaries` | The post-boundary control is active without key material. | A: valid active-path test |
| 12 | `test/v5-trusted-key-resolver-adversarial.test.js` | `keyReference validation is consistent for input and records` | Valid boundary controls are active without key material. | A: valid active-path test |
| 13 | `test/v5-trusted-key-resolver-adversarial.test.js` | `repeated references remain deterministic and inputs remain unchanged` | The repeat input is active without key material. | A: valid active-path test |
| 14 | `test/v5-trusted-key-resolver-adversarial.test.js` | `insertion order and host globals do not alter semantic output` | Both valid inputs are active without key material. | A: valid active-path test |

The mandatory missing-key classification is separately pinned by binding
fixture `04-active-missing-key.json`: keep its missing key and expect the
exact malformed result. No listed legacy test currently supplies a selected
active record that is intentionally missing key material; later implementation
work must add no compatibility fallback for that case.

## Legacy Fixture Migration

Only these legacy fixtures have an expected active result and require migration:

| File | Case ID | Exact migration |
| --- | --- | --- |
| `test/fixtures/v5/trusted-key-resolver/01-active-key-reference.json` | `resolver-active-key-reference` | Preserve filename, case ID, and lifecycle scenario. Add a fixture-only `publicKeySpkiDer` descriptor to the active record and update expected output to `keyState`, requested `keyReference`, and `publicKeySpkiDerHex`. |
| `test/fixtures/v5/trusted-key-resolver/12-deterministic-repeat.json` | `resolver-deterministic-repeat` | Preserve filename, case ID, equivalent inputs, and deterministic scenario. Add the same canonical descriptor independently to both active records and update expected output to the bound active metadata shape. |

All other legacy fixture files remain semantically unchanged. The migration must
reuse the existing descriptor contract only:

```txt
buffer-hex
uint8array-hex
raw-json
```

`publicKeySpkiDerHex` is fixture-only expected metadata. The runtime resolver
receives only materialized Buffer or Uint8Array input and returns a fresh
Buffer under `publicKeySpkiDer`; descriptors never reach runtime.

## Direct-Test Migration

The two existing direct resolver test files contain all fourteen observed
failures. Every listed control is Classification A: it remains a valid active
path after adding canonical public-only 44-byte material and asserting the
exact bound active output shape:

```js
{
  keyState: 'active',
  keyReference: '<requested key reference>',
  publicKeySpkiDer: <fresh Buffer>
}
```

Future direct test updates must continue to cover the original condition they
exercise: timestamp parsing, dense arrays, matching, expiry, determinism,
immutability, bounded output, null-prototype/frozen inputs, and host-global
independence. They must not downgrade those controls to missing-key failures.

Classification B remains mandatory for any direct test that deliberately
constructs an otherwise-active selected record without `publicKeySpkiDer`:
preserve the missing field and assert the exact malformed trusted-key-record
result. Binding fixture 04 is the canonical existing example.

## Preserved Resolver Contract

This amendment does not alter:

```txt
public API: resolveTrustedKeyState
root allowlist: keyReference, records, evaluationTime
zero matches: unknown
multiple matches: malformed
revoked/unavailable/unknown/malformed mappings
expiresAt <= evaluationTime: expired
whole-record malformed precedence
case 11 and case 20: malformed
case 15: unknown
cases 16 and 17: ambiguous malformed
existing state and reason vocabulary
```

The canonical active output is now exactly:

```js
{
  keyState: 'active',
  keyReference,
  publicKeySpkiDer: <fresh Buffer>
}
```

Non-active outputs continue to contain neither key bytes nor key reference.

## Exact Future Implementation Surface

Only the following files are proven necessary for a later, separately
authorized V25A5 retry:

```txt
lib/v5/trusted-key-resolver.js
test/v5-trusted-key-resolver-binding.test.js
test/fixtures/v5/trusted-key-resolver/01-active-key-reference.json
test/fixtures/v5/trusted-key-resolver/12-deterministic-repeat.json
test/v5-trusted-key-resolver-fixtures.test.js
test/v5-trusted-key-resolver.test.js
test/v5-trusted-key-resolver-adversarial.test.js
```

No glob and no additional resolver surface is authorized by this document.
`test/v5-trusted-key-resolver-fixtures.test.js` is included only because it
currently materializes and validates the legacy corpus envelope. Its future
change must be confined to the two migrated active fixture expected shapes.

The frozen patch in
`C:\Users\sonfi\Desktop\huqan-v25a5-resolver-binding-implementation` remains
uncommitted. Its source change may be reused only after review against this
merged reconciliation; its binding test may be reused only after review
against the migrated legacy surface. Neither may be committed before this gate
closes and a later implementation authorization is given.

## Required Future Validation

A future V25A5 retry must prove all of the following:

```txt
20/20 binding fixtures pass
12/12 legacy fixtures pass
valid legacy active cases return bound active shape
missing active key returns malformed
non-active legacy results are unchanged
case 04 remains malformed
cases 11 and 20 retain whole-record malformed precedence
case 15 remains unknown
cases 16 and 17 remain ambiguous
defensive-copy, fixture-contract, adversarial, and verification-boundary tests pass
full suite has zero failures
```

## Historical Amendment And Stop Conditions

V25A4 stated that existing legacy fixtures and tests remain unchanged. This
document supersedes that statement only where it conflicts with mandatory
active key binding. V25A4 itself is neither rewritten nor deleted.

Stop without code changes if a public compatibility promise requires
active-without-key behavior, the legacy consumer cannot materialize the
canonical descriptor, the old active shape is consumed outside the named
resolver test surface, an unrelated baseline regression appears, or a new
state, reason, or compatibility mode appears necessary.

## Permanent Non-Claims

This reconciliation does not add a resolver implementation, crypto, key
management, certificate validation, signature verification, trust,
authorization, network/database lookup, transport, exchange, A2A, connector
enforcement, marketplace behavior, AgentAction policy behavior, or a V5
complete claim.
