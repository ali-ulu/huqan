# V5-VERIFICATION-7 - Trusted-Key Resolver Scope Definition

**Status:** `spec`

**Mode:** Scope definition only
**Current checkpoint:** `V5-VERIFICATION-6_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ b7789d7bba211765ee7dc7dd423fb361054e3bcb`

## Purpose

`V5-VERIFICATION-7` defines the future boundary for resolving a bounded
trusted-key state before the verification core is called. It does not add a
resolver implementation, key store, cryptographic verification, or runtime
behavior.

The existing verification core consumes a previously resolved key state. This
separation must remain explicit:

```txt
bounded keyReference + fixed evaluation time
-> separately resolved key-state result
-> bounded verification core
```

The resolver is not a cryptographic adapter and does not decide package trust
or action authorization.

## Resolver Responsibility

A future resolver may only classify a supplied non-secret `keyReference` into
the existing bounded states:

```txt
active
unknown
revoked
expired
unavailable
malformed
```

It must return a deterministic, serializable resolved key-state record for the
same bounded input and the same fixed evaluation time. A resolver must not
invent a key, silently substitute a fallback key, or make an unresolved input
appear active.

The existing verification-core reason vocabulary remains authoritative. This
scope does not add statuses, reason categories, algorithms, or output fields.

## Bounded Input and Output

A future resolver input must be limited to:

- a non-secret bounded `keyReference`
- a fixed evaluation time supplied by the caller
- explicitly approved resolver configuration supplied by a later scope

A future resolver output must contain only the bounded key-state information
required by the verification core. It must not include private keys, secrets,
credentials, tokens, passwords, certificate bodies, PEM data, JWK material,
network endpoints, URLs, or opaque provider responses.

Unknown fields, nested data, arrays, secret-bearing material, malformed
references, and ambiguous records must fail closed as `malformed` or another
existing bounded state established by the later fixture contract. No new state
or reason category may be introduced by implementation convenience.

## Determinism and Fail-Closed Rules

The future resolver contract must preserve this invariant:

```txt
same bounded keyReference
+ same fixed evaluation time
+ same approved resolver input
-> same resolved key-state result
```

At minimum, these outcomes must remain fail-closed:

```txt
missing or malformed keyReference -> malformed
unknown key                      -> unknown
revoked key                      -> revoked
expired metadata at fixed time   -> expired
lookup unavailable               -> unavailable
ambiguous or unsafe record       -> malformed
```

No resolver failure may produce an `active` result. The resolver must not read
the system clock, depend on hidden global state, generate random values, or
mutate its input.

## Resolver and Crypto Separation

The resolver classifies key state; it does not evaluate signature bytes or
cryptographic evidence. A future cryptographic adapter remains a separate
scope after the resolver chain is closed.

The resolver must not:

- generate, import, export, rotate, or manage keys
- produce signatures or verify signatures
- validate certificate chains
- make network, database, key-store, identity-provider, or cache calls in this
  scope definition
- change `lib/v5/verification-core.js`
- infer package trust, identity verification, content safety, authorization, or
  execution approval

## Future Gate Sequence

After this document is separately reviewed and closed, the intended sequence
is:

```txt
resolver fixture scope definition
-> resolver fixtures
-> resolver fixture contract tests
-> resolver implementation scope definition
-> resolver implementation
-> resolver adversarial tests
-> resolver closeout audit
-> separately scoped cryptographic adapter work
```

No step is automatic. Each gate requires its own approval and must preserve
the existing verification-core contract.

## Stop Conditions

A later resolver task must stop and report rather than expand scope if it
requires:

- a new key-state or verification reason category
- a schema, fixture, test, package, reader, writer, or verification-core change
- network access, database access, key storage, cache policy, or identity
  provider integration
- real key material, certificates, crypto dependencies, or signature handling
- a trust or authorization decision

## Explicit Non-Claims

This scope definition does not mean:

- a trusted-key resolver exists
- key lookup, key storage, key lifecycle, or rotation exists
- signatures are cryptographically verified
- public or private key material is handled
- packages are trusted
- actions are authorized
- runtime exchange, transport, or persistence exists
- A2A, connector enforcement, marketplace, or AgentAction policy engine exists
- V5 is complete

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-verification-7-trusted-key-resolver-scope-definition.md`
- `git diff --check main...HEAD` passes
- no resolver implementation, crypto, schema, fixture, test, package, or
  runtime files change
- the document preserves the verification-core status and reason vocabulary
- the document makes no trust, authorization, or V5-complete claim

## Recommended Next Gate

`V5-VERIFICATION-8_TRUSTED_KEY_RESOLVER_FIXTURE_SCOPE_DEFINITION`

That gate must remain docs-only and define future resolver fixture categories
without adding a resolver, key material, cryptographic verification, or
network behavior.
