# V5-VERIFICATION-15 - Trusted-Key Resolver Adversarial Test Scope Definition

**Status:** `spec`

Mode: adversarial test scope definition only
Current checkpoint: V5-VERIFICATION-14_CLOSEOUT_AUDIT_GREEN
Canonical base: main @ 82500a9d287b7bd1b471750b4472e83324122377

## Purpose

V5-VERIFICATION-15 defines the future adversarial test contract for the
implemented trusted-key resolver. V15 adds no test code, production code,
fixture, schema, package, or runtime behavior.

The system under test remains the existing synchronous API:

    resolveTrustedKeyState({ keyReference, records, evaluationTime })

The future suite searches for fail-open, non-deterministic, mutation,
exception-leakage, and bounded resource-safety defects within the existing
V7-V14 contract. It must not invent states, reason categories, output fields,
trust decisions, authorization decisions, crypto behavior, or live lookup.

## System Under Test

Current implementation:

    lib/v5/trusted-key-resolver.js

Current ordinary tests:

    test/v5-trusted-key-resolver.test.js
    test/v5-trusted-key-resolver-fixtures.test.js

Current corpus:

    test/fixtures/v5/trusted-key-resolver/*.json

The future separately authorized adversarial test file is:

    test/v5-trusted-key-resolver-adversarial.test.js

A production patch may be allowed in that future gate only when a failing
adversarial reproducer proves a concrete defect. Such a patch remains limited
to lib/v5/trusted-key-resolver.js.

## Permanent Regression Floor

PR #237 recovery findings remain permanent regression cases:

- impossible calendar date -> malformed / malformed_trusted_key_record
- URL or network-shaped keyReference -> malformed / malformed_trusted_key_record
- sparse records array -> malformed / malformed_trusted_key_record

The future suite must also retain valid leap-day acceptance, expiry before/at/after
the evaluation instant, duplicate ambiguity independent of order, exact output
shape, and no exception or exception-text leakage for supported untrusted input.

## Root-Input Matrix

Plan bounded tests for null, undefined, primitives, arrays, functions, Date
instances, RegExp instances, boxed primitives, null-prototype objects,
inherited-property objects, relevant enumerable symbol properties, frozen
objects, and sealed objects.

Unsupported root forms must fail closed without throwing or mutating input.
The future suite must not assume every JavaScript object shape is supported.

Getter, symbol, non-enumerable, and prototype behavior is not expanded here.
If V7-V14 do not define a behavior, the future implementation gate must stop
and request a contract decision instead of inventing semantics.

## Array-Integrity Matrix

Plan tests for empty dense arrays; holes at the beginning, middle, and end;
undefined, null, and primitive elements; extra enumerable non-index properties;
a safe bounded large declared length with sparse content; duplicate matching
records in different orders; identical duplicates; and non-matching duplicates.

Every numeric index from zero through length minus one must be present before
record selection. No test may allocate excessive memory or create a denial of
service condition.

## Timestamp Matrix

Preserve the exact timestamp grammar implemented by V14. Plan tests for
impossible day, impossible month, day zero, non-leap February 29, valid leap
February 29, missing timezone, unauthorized offset timestamps, excessive
fractional precision, malformed timezone markers, trailing characters,
whitespace, numeric timestamps, Date objects, Infinity/NaN equivalents,
malformed evaluationTime, malformed expiresAt, equality, one millisecond
before, and one millisecond after expiry.

The suite must not broaden timestamp acceptance. Parsed instants, not lexical
strings, remain authoritative, and exact equality remains expired.

## keyReference Matrix

Apply the same bounded validation to input.keyReference and record.keyReference.
Plan tests for http, https, file, ftp, ws, wss, arbitrary scheme prefixes,
authority syntax, embedded credentials, query and fragment syntax, traversal-like
paths, control characters, newline, tab, leading/trailing whitespace, empty
strings, the authorized maximum length, one character beyond it, relevant
Unicode confusables, and valid canonical fixture identifiers.

The suite must not invent an alternate identifier grammar.

## Unknown and Forbidden Fields

Plan recursive tests at root, record, nested object, nested array, array-of-array,
and mixed object/array levels. Canonical concepts remain:

    privateKey, secret, token, credential, password, keyMaterial
    private-key or PEM material, provider, endpoint, URL, network configuration

Case normalization must match the current contract. No new forbidden vocabulary
may be added without a separate contract amendment.

## Prototype and Traversal Boundaries

Plan bounded checks for inherited forbidden/unknown fields, own enumerable fields,
non-enumerable fields, getter properties, throwing getters, __proto__, constructor,
and prototype.

Getter, symbol, non-enumerable, prototype-pollution, and cyclic-graph behavior
must not be silently invented. If a test requires a choice not established by
V7-V14, preserve the reproducer and stop for a contract decision.

Plan bounded nested objects, nested arrays, and repeated object references.
The future gate must select a safe maximum depth from the actual implementation.
Cycles are a contract gap unless V7-V14 explicitly define them; no arbitrary
cycle policy may be introduced.

## Exception Containment

For supported untrusted inputs, tests must prove no exception escapes, no
exception text or stack trace enters the result, and output remains one of the
canonical bounded shapes. The suite must not hide unrelated programmer errors
unless V13 already requires that behavior.

## Determinism and Immutability

The future suite must verify repeated deep-equal results, record-order-independent
duplicate outcomes, insertion-order-independent semantics, host-timezone and
locale independence, environment independence, no randomness, no filesystem
writes, no network/database access, and no mutable module cache.

Deep snapshots must prove that root input, records, record objects, nested objects,
and fixture objects are not modified, reordered, or annotated. Frozen inputs must
remain usable where otherwise valid.

## Output Confinement

Every adversarial case must assert an exact output object. The only states are:

    active, unknown, revoked, expired, unavailable, malformed

The only non-active reasons are:

    unknown_key
    revoked_key
    expired_key_metadata
    key_lookup_unavailable
    malformed_trusted_key_record

Reject extra, undefined, or unauthorized null fields; free-form explanations;
raw exception details; input or record echoes; provider/network metadata; trust
scores; and authorization verdicts.

## Resource-Safety Boundary

Use only bounded tests for long allowed references, just-over-limit references,
moderate record counts, and moderate nesting depth. Do not run uncontrolled
fuzzing, infinite loops, huge allocations, or unbounded property generation in
normal CI. Generated cases, if used, must be deterministic, seeded, bounded,
and dependency-free.

## Fixture Preservation

The 12 canonical resolver fixtures are read-only. The future suite may read
them but must not rewrite, supplement, mutate, or replace them, and must not
change the existing fixture contract test.

## Verification-Core Boundary

Adversarial tests may verify bounded shape compatibility only. They must not
edit or bypass lib/v5/verification-core.js, payload/digest checks, algorithm
checks, or signature-evidence checks. They must not perform cryptographic
verification or create package trust or authorization output.

## Future Gate File Scope

The next separately authorized gate defaults to:

    test/v5-trusted-key-resolver-adversarial.test.js

Only a concrete failing reproducer may authorize a production patch, limited to:

    lib/v5/trusted-key-resolver.js

No fixture, docs, schema, validator, package, runtime, MCP,
verification-core, crypto, key-store, network, or database file may be added
without a new scope decision.

## Future Validation

The future gate must run:

    node --test test/v5-trusted-key-resolver-adversarial.test.js
    node --test test/v5-trusted-key-resolver-fixtures.test.js test/v5-trusted-key-resolver.test.js test/v5-trusted-key-resolver-adversarial.test.js test/v5-verification-core.test.js
    npm test
    git diff --check main...HEAD
    git diff --name-only main...HEAD
    git status --short

Any failing adversarial test must first be preserved as a minimal reproducer
before a production patch is applied.

## Permanent Non-Claims

This document does not mean that real cryptographic verification, certificate
validation, a live key store, network/database provider, key generation/rotation,
a revocation service, package trust, authorization, A2A, connector enforcement,
runtime exchange/transport/persistence, or a V5-complete system exists.

## Forbidden Scope

V15 must not contain resolver modification, test implementation, fixture
modification, verification-core modification, schema/validator modification,
package/dependency modification, crypto/certificate code, runtime/MCP change,
network/database/key-store integration, trust/authorization output, or broad
staging.

## Exit Criteria

This docs-only PR may close only if the only changed file is:

    docs/v5/v5-verification-15-trusted-key-resolver-adversarial-test-scope-definition.md

Also required: git diff --check main...HEAD passes; V7-V14 contracts remain
consistent; PR #237 regressions are permanently planned; undefined getter,
symbol, prototype, and cycle behavior is marked as a stop condition; no code,
test, fixture, schema, package, runtime, crypto, network, or MCP file changes;
and no trust, authorization, or V5-complete claim.

## Recommended Next Gate

V5-VERIFICATION-16_TRUSTED_KEY_RESOLVER_ADVERSARIAL_TESTS

That gate requires separate approval. It may add the adversarial test file and
may patch the resolver only when a concrete failing reproducer proves a defect.
V15 itself authorizes neither test implementation nor production patching.
