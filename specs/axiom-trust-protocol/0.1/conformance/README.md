# ATP v0.1 Conformance

## Four levels of evidence, and which one you are looking at

These get conflated constantly, and the difference decides what a green run is
worth. In increasing order of strength:

| Level | What it means |
| --- | --- |
| **Self-test** | One implementation checks its own output with its own code. Proves internal consistency, nothing about the specification. |
| **Cross-implementation conformance** | A second implementation, written from the specification and sharing no code with the producer, agrees on the same artifacts. The author may be the same person. Proves the specification is implementable and unambiguous. |
| **Third-party verification** | An independent person or organisation writes a verifier from the specification, without our help or our code, and reaches the same verdicts. Proves the specification is followable by someone who cannot ask us what it meant. |
| **Interoperability** | Two independent systems actually exchange trust artifacts, including fail-closed behaviour on invalid ones. Proves the format works in the field. |

Naming a third-party verifier "interoperability" overstates it; calling
cross-implementation conformance "just a self-test" understates it. Both errors
are easy, so state the level explicitly whenever citing a result.

**Where this repository stands today:**

- object shape checks — **self-test**;
- receipt bundle — **cross-implementation conformance**, via the Python verifier
  described below;
- third-party verification — **none**;
- interoperability — **none**.

`packages/huqan-verify` is a self-test surface: it reuses
`lib/atp-conformance.js` and `lib/axiom-package-format.js` rather than
implementing the specification independently, and reports `status: 'skeleton'`
in its own exported surface. The legacy `packages/axiom-verify` path re-exports
that canonical module.

## Object shape self-tests

The in-repo helper checks required fields, enum values, confidence ranges,
timestamp parseability, provenance and trust receipt integrity, ATP/AVP object
shape compatibility, and causal chain and simulation payload sanity.

```bash
node --test lib/atp-conformance.test.js
```

The helper implementation lives in `lib/atp-conformance.js`. It is the producer's
own validator; see the table above before citing its results.

## Receipt bundle — cross-implementation conformance

The receipt bundle is the one artifact here that an outside party can verify end
to end from the document alone:

- specification: [`../RECEIPT-BUNDLE.md`](../RECEIPT-BUNDLE.md)
- schema: [`../schemas/trust-receipt-bundle.schema.json`](../schemas/trust-receipt-bundle.schema.json)
- fixtures: [`../examples/`](../examples/)

```text
receipt-bundle.valid.json                  passes all three checks
receipt-bundle.unicode.valid.json          passes, and exercises the portability rules
receipt-bundle.tampered-bundle-hash.json   fails the bundle seal only
receipt-bundle.broken-chain.json           fails chain self-consistency at index 1
```

All four come from the real export path, not from hand-editing. The two negatives
differ from `receipt-bundle.valid.json` by exactly one JSON leaf.

`receipt-bundle.unicode.valid.json` is the one that matters for portability. The
ASCII fixture passes under three different wrong canonicalizations; the Unicode
one does not. It carries Turkish text, `U+E000` and `U+1F600` as keys in the same
object, and numbers on both sides of the `1e-7` threshold.

### The second implementation

```bash
python3 conformance/verify_bundle.py ../examples/receipt-bundle.valid.json
```

`verify_bundle.py` is written from `RECEIPT-BUNDLE.md` only. It imports no HUQAN
code, needs no third-party package, and re-derives canonical serialization,
UTF-16 key ordering, string escaping and ECMAScript number formatting from the
document. It agrees with the JavaScript producer on all four fixtures.

That agreement is the conformance evidence — of *portability*. Two independent
implementations reach the same bytes and the same verdict from the document
alone, which is what makes the specification implementable rather than
reverse-engineered.

Do not read it as an assurance claim about any particular bundle:

> A `VALID` verdict means the bundle satisfies the three specified consistency
> checks. It does not establish issuer identity, and it does not prove that a
> capable editor has not rewritten and resealed the bundle. See
> [What verifying a bundle does and does not prove](../RECEIPT-BUNDLE.md#what-verifying-a-bundle-does-and-does-not-prove).

Conformance level and assurance level are different axes. Agreement between
implementations says the format is unambiguous; it says nothing about what a
verified bundle guarantees.

The agreement is also what caught the original specification's gaps: the first
draft said only "RFC 8259, minified, sorted keys", and a Python implementation
following it faithfully produced different
bytes in three separate ways — escaped non-ASCII, code-point key ordering, and
zero-padded exponents. The specification was corrected; the runtime was not
touched, because the runtime was never wrong.

`test/v5-c5a-receipt-bundle-spec.test.js` runs this probe when `python3` is
available and skips it otherwise, so the agreement is checked continuously
rather than claimed once.

## How to write an independent verifier

An implementation qualifies as independent when it imports nothing from `lib/`
and follows `RECEIPT-BUNDLE.md` only. Sharing this repository is fine; sharing
the producer's implementation is not.

The minimum is roughly a hundred lines in most languages. Start from
`verify_bundle.py` if it helps, then run against all four fixtures — two pass,
two fail with the documented reason and index. If your implementation disagrees
with a fixture, that is worth reporting: either the specification is wrong or the
fixture is, and both are defects.

Doing this **without contact with us** is the step that would turn this from
cross-implementation conformance into third-party verification. Nothing in this
repository can produce that evidence on its own.
