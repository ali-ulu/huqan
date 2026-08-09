# ATP v0.1 Conformance

## What conformance means here, and what it does not

This directory holds the conformance reference for AXIOM Trust Protocol v0.1.

Read this first, because the distinction is load-bearing:

- **Self-test.** HUQAN's own test suite checking HUQAN's own objects with
  HUQAN's own validators. It proves the implementation agrees with itself.
- **Conformance evidence.** An independent implementation, sharing no code with
  the producer, agreeing with the published specification on the same fixtures.
- **Interoperability evidence.** A real external consumer or producer exchanging
  trust objects with HUQAN, including fail-closed behaviour on invalid ones.

Everything in this repository today is the **first** kind. Nothing here is
conformance or interoperability evidence, and no claim of either should be
derived from a green in-repo test run.

That includes `packages/axiom-verify`, which re-exports
`lib/atp-conformance.js` and `lib/axiom-package-format.js` rather than
implementing the specification independently, and reports `status: 'skeleton'`
in its own exported surface.

## Object shape self-tests

The in-repo helper checks required fields, enum values, confidence ranges,
timestamp parseability, provenance and trust receipt integrity, ATP/AVP object
shape compatibility, and causal chain and simulation payload sanity.

```bash
node --test lib/atp-conformance.test.js
```

The helper implementation lives in `lib/atp-conformance.js`. It is the producer's
own validator; see the distinction above before citing its results.

## Receipt bundle

The receipt bundle is the one artifact in this specification that an outside
party can verify end to end from the document alone:

- specification: [`../RECEIPT-BUNDLE.md`](../RECEIPT-BUNDLE.md)
- schema: [`../schemas/trust-receipt-bundle.schema.json`](../schemas/trust-receipt-bundle.schema.json)
- fixtures: [`../examples/`](../examples/)

```text
receipt-bundle.valid.json                  passes all three checks
receipt-bundle.tampered-bundle-hash.json   fails the bundle seal only
receipt-bundle.broken-chain.json           fails chain self-consistency at index 1
```

The fixtures are produced by the real export path, not written by hand, and each
negative differs from the valid bundle by exactly one JSON leaf.

`test/v5-c5a-receipt-bundle-spec.test.js` checks that the published document and
the shipped fixtures agree — that the documented algorithm reproduces the
recorded `bundleHash`, and that each negative fixture fails the specific rule it
targets. That test is still a self-test. Its purpose is to keep the specification
honest, not to substitute for an independent implementation.

## How to write an independent verifier

An implementation qualifies as independent when it imports nothing from `lib/`
and follows `RECEIPT-BUNDLE.md` only. Sharing this repository is fine; sharing
the producer's implementation is not.

The minimum is roughly a hundred lines in most languages: deterministic JSON
serialization with recursively sorted object keys, SHA-256 over UTF-8, and the
three checks in the verification algorithm. Running it against the three fixtures
above — one pass, two fails with the documented reason and index — is the first
piece of real conformance evidence this project would have.

If your implementation disagrees with a fixture, that is worth reporting. Either
the specification is wrong or the fixture is, and both are defects.
