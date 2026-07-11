# V5 Verification-17B Cryptographic Evidence Handoff Contract

## Purpose

This document defines the bounded handoff from a future cryptographic adapter to
the existing V5 verification core. It does not add cryptographic verification,
key resolution, trust, authorization, or final verification composition.

## Ownership Boundary

The future cryptographic adapter owns the cryptographic primitive and converts
its bounded result to the profile defined by
`lib/v5/cryptographic-profile-contract.js`. A future trusted-key resolver owns
key lookup and key-state resolution. The verification core owns only handoff
shape validation through `normalizeCryptographicVerificationEvidence`.

`test-structural-v1` remains a synthetic bounded verification algorithm. This
handoff does not change `evaluateBoundedVerification` or its precedence.

## Accepted Evidence

The normalizer accepts a plain object with own enumerable data properties only.
It accepts exactly these state/reason pairings:

| cryptographicState | reasonCategory |
| --- | --- |
| `valid` | absent |
| `invalid` | `signature_invalid` |
| `malformed` | `input_malformed`, `message_malformed`, `public_key_malformed`, or `signature_malformed` |
| `unsupported` | `algorithm_unsupported` |

Any other shape, field, state, reason, inherited property, accessor, or
non-object is normalized without throwing to a fresh result:

```js
{
  cryptographicState: 'malformed',
  reasonCategory: 'input_malformed'
}
```

## Determinism And Safety

For the same bounded adapter evidence, the normalizer returns the same fresh
plain result and does not mutate its input. It exposes neither exception details
nor adapter implementation details.

## Deliberate Non-Claims

This gate does not add a crypto adapter, real signature verification, crypto
dependency, trusted-key resolver, key store, network access, clock access,
certificate validation, package trust, action authorization, transport,
exchange, A2A, connector enforcement, marketplace, AgentAction policy engine,
or a V5-complete claim.

## Next Gates

Future composition is a separate gate after both the trusted-key resolver and
the cryptographic adapter have their own scope, fixture, test, implementation,
and closeout evidence. No caller may treat this handoff result as a final core
verification decision before that composition gate.
