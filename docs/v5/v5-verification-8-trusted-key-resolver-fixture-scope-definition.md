# V5-VERIFICATION-8 - Trusted-Key Resolver Fixture Scope Definition

**Mode:** Fixture scope definition only
**Current checkpoint:** `V5-VERIFICATION-7_CLOSEOUT_AUDIT_GREEN`
**Canonical branch:** `main`
**Required base:** `main @ 463ebc912dd66ded7cc88540610917f19d0a5cd8`

## Purpose

`V5-VERIFICATION-8` defines the future fixture corpus for trusted-key resolver
behavior. It does not add fixture files, resolver implementation, network
lookup, database lookup, key storage, cryptographic verification, or runtime
behavior.

The fixture corpus must later prove that a resolver can classify a bounded
non-secret `keyReference` into a deterministic resolved key-state record before
the verification core is called:

```txt
bounded keyReference + fixed evaluation time
-> resolver fixture expectation
-> future resolver implementation
-> bounded resolved key-state result
-> verification core
```

The fixtures must not imply package trust, action authorization, identity
verification, transport, exchange, or V5 completion.

## Fixture Boundary

Future resolver fixtures may describe only static, deterministic resolver
inputs and expected resolved key-state outputs.

Allowed fixture inputs:

- a non-secret `keyReference`
- a fixed evaluation time
- fixture-local static key-state records
- fixture-local expected status and reason metadata

Forbidden fixture inputs:

- private keys
- secrets, credentials, tokens, or passwords
- public key material that could be mistaken for production key material
- PEM, certificate bodies, JWK, or key-material blobs
- network endpoints, URLs, database handles, cache handles, or provider
  responses
- dynamic system-clock expectations
- resolver implementation hooks
- cryptographic signature evidence evaluation

## Required Future Fixture Categories

The future corpus should cover at least these fixture categories:

```txt
valid active key reference
unknown key reference
revoked key reference
expired key metadata at fixed evaluation time
lookup unavailable
malformed key reference
malformed trusted-key record
ambiguous duplicate key record
nested secret-bearing key metadata
network or provider-response leakage
```

Each fixture category must have a deterministic expected key-state result. No
fixture may require a new verification status, reason category, schema change,
or verification-core output field.

## State Coverage

The future fixtures must preserve the resolver states already defined by
`V5-VERIFICATION-7`:

```txt
active
unknown
revoked
expired
unavailable
malformed
```

No other key-state may be introduced in this fixture gate. If a new state is
needed, the work must stop and return to scope review.

## Expected Fail-Closed Behavior

The future fixtures must make these fail-closed expectations explicit:

```txt
missing keyReference             -> malformed
malformed keyReference           -> malformed
unknown keyReference             -> unknown
revoked key record               -> revoked
expired metadata at fixed time   -> expired
lookup unavailable               -> unavailable
ambiguous duplicate record       -> malformed
unsafe nested metadata           -> malformed
network/provider leakage         -> malformed
secret/private-key material      -> malformed
```

No failure fixture may resolve to `active`.

## Determinism Requirements

Each future fixture must be deterministic:

```txt
same fixture input
+ same fixed evaluation time
+ same fixture-local key-state records
-> same expected resolved key-state result
```

Fixtures must not rely on wall-clock time, random values, environment
variables, filesystem state outside the fixture corpus, network state, caches,
or hidden global state.

## Resolver and Crypto Separation

Future resolver fixtures must not test cryptographic verification. They may
only describe key-state classification for a bounded key reference.

The following remain separate future scopes:

- resolver implementation
- resolver adversarial tests
- cryptographic adapter scope
- cryptographic adapter fixtures
- cryptographic adapter implementation

Resolver fixtures must not contain signature validation examples that imply
real cryptographic verification.

## Fixture File Expectations

A later fixture-only PR may add JSON fixtures under a dedicated V5 resolver
fixture directory, such as:

```txt
test/fixtures/v5/trusted-key-resolver/
```

That future PR must not modify schemas, tests, implementation files, package
metadata, verification-core behavior, runtime reader/writer helpers, MCP
surfaces, or docs outside its approved scope.

Each fixture should include only bounded structural data required to prove the
resolver contract. Fixture contents must be parseable JSON and must preserve
the explicit non-claims.

## Stop Conditions

A future resolver fixture task must stop and report rather than expand scope if
it requires:

- a new key-state
- a new verification reason category
- resolver implementation
- cryptographic verification
- real key material or certificates
- network, database, cache, or identity-provider behavior
- package trust, action authorization, connector enforcement, or A2A behavior
- schema, validator, package, reader, writer, MCP, or verification-core changes

## Explicit Non-Claims

This scope definition does not mean:

- trusted-key resolver fixtures exist
- a trusted-key resolver exists
- key lookup, key storage, key lifecycle, or rotation exists
- cryptographic verification exists
- public or private key material is handled
- packages are trusted
- actions are authorized
- runtime exchange, transport, or persistence exists
- A2A, connector enforcement, marketplace, or AgentAction policy engine exists
- V5 is complete

## Exit Criteria

This docs-only PR may close only if:

- the only changed file is
  `docs/v5/v5-verification-8-trusted-key-resolver-fixture-scope-definition.md`
- `git diff --check main...HEAD` passes
- no resolver fixture files are added
- no resolver implementation, crypto, schema, test, package, or runtime files
  change
- the document preserves the resolver states from `V5-VERIFICATION-7`
- the document makes no trust, authorization, crypto, resolver-runtime, or
  V5-complete claim

## Recommended Next Gate

`V5-VERIFICATION-9_TRUSTED_KEY_RESOLVER_FIXTURES`

That gate may be fixture-only if separately approved. It must not add resolver
implementation, cryptographic verification, network behavior, database access,
key storage, package trust, or action authorization.
