# V5-C5 — External Conformance Entry Audit

## Status

`V5_C5_EXTERNAL_CONFORMANCE_ENTRY_BLOCKED_GAP`

Docs-only. This audit records why the V5-C5 external conformance runner cannot
be started as specified, and authorizes the bounded prerequisite that would make
it possible. It implements nothing, renames nothing, and makes no V5 entry claim.

Controlling documents:

- `docs/adr/ADR-010-v5-ecosystem-entry.md` (phase boundary)
- `docs/current-operating-roadmap.md` (`V5_IMPLEMENTATION_ENTRY: FAIL`)
- `docs/v4-b5-source-test-ci-release-closeout.md` (V4 closed)

Issue `#277` (`V5-C5`) is the tracked gate. The controlling roadmap names it as
the remaining V5 implementation-entry blocker.

## Declared blocker is real

Issue `#277` states its own dependency: `Blocker: V5-C2..C4 gerekli`. At the time
of this audit all three are open:

```text
#274  [V5-C2] ATP to HTP compatibility RFC                        OPEN
#275  [V5-C3] Bounded A2A Trust Exchange schema and fixtures      OPEN
#276  [V5-C4] Public-safe Trust Receipt schema and redaction      OPEN
```

Two of C5's acceptance criteria name those deliverables directly — "ATP/HTP
compatibility testleri var" needs C2, and "Missing scope/evidence/expiry negatif
testleri var" needs the C3 exchange schema that defines scope, evidence and
expiry. So C5 cannot be completed as written.

That alone would only make C5 *premature*. The findings below make it **blocked**
for reasons no amount of C2–C4 progress resolves.

## Source-reality findings

### 1. There is no external verifier — only a re-export of the producer's code

`packages/axiom-verify/index.js` presents itself as the verification package. Its
first two statements reach out of the package into the repository it is meant to
verify:

```js
} = require('../../lib/atp-conformance');
const { validateAxiomPackage, validateAxiomPackageFile, ... } = require('../../lib/axiom-package-format');
```

It declares no dependencies, adds no checks of its own beyond one
`verificationResult` status guard, and self-reports its maturity in its own
exported surface:

```js
status: 'skeleton',
```

Both requires resolve inside the published tarball, because `lib/atp-conformance.js`
and `lib/axiom-package-format.js` are in the `files` allowlist. That is a
packaging fact, not an independence fact: a conformance runner built on this
package would validate HUQAN's output using HUQAN's own validators.

An external conformance runner whose verifier is the producer's implementation
cannot produce interoperability evidence. It can only prove the code agrees with
itself, which the in-repo suite already proves more cheaply.

### 2. The existing conformance reference is explicitly a self-test

`specs/axiom-trust-protocol/0.1/conformance/README.md` documents how to run
conformance:

```text
node --test lib/atp-conformance.test.js

The helper implementation lives in `lib/atp-conformance.js`.
```

The conformance reference names the repository's own module as the
implementation and its own unit test as the runner. This is honest, and it is
also the opposite of what C5 asks for.

### 3. The flagship verifiable artifact has no published specification

V4-B3 (PR #588) made a chain-validated receipt bundle reachable at
`GET /api/workbench/receipt-bundle`. That bundle is now the artifact an external
party would most plausibly verify.

Its integrity semantics are not specified anywhere under `specs/`:

```bash
$ grep -rn "bundleHash\|previousReceiptHash\|receiptHash" specs/
(no matches)

$ grep -ni "bundle" specs/axiom-trust-protocol/0.1/README.md
(no matches)
```

The ATP 0.1 schema set covers `trust-receipt`, `provenance-record`,
`audit-event`, `candidate-claim`, `conflict-result`, `verification-result`,
`causal-chain`, `simulation-result` and `error`. It has no concept of a receipt
*bundle*, no chain linkage rule, and no hashing algorithm.

The algorithm exists only in source:

```js
// lib/receipt/receipt-export.js:44
const bundleHash = sha256Hex(stableStringify(receipts));
```

So an independent implementer cannot re-verify a HUQAN receipt bundle from the
published specification. They would have to read `lib/receipt/receipt-export.js`,
`lib/receipt/receipt-chain.js` and `lib/receipt/canonical-receipt.js` and
reproduce their behaviour — which is reverse-engineering, not conformance.

### 4. The specification is not distributed

`package.json` `files` ships the verifier but not the specification it claims to
implement:

```text
packages/axiom-verify/index.js
packages/axiom-verify/package.json
```

No `specs/**` and no `schemas/**` entry exists in the allowlist. An external
consumer who installs the package receives validators and examples of neither the
protocol schemas nor the conformance material.

## Why this is a blocked gap rather than a plan

C5's purpose is external interoperability evidence: proof that something outside
this repository can produce or check a HUQAN-compatible trust object. Every
ingredient that would make such proof meaningful is missing:

- the verifier is the producer's code;
- the conformance reference is the producer's unit test;
- the artifact most worth verifying has no published format; and
- the specification is not shipped to anyone who installs the package.

Building a runner on top of that would satisfy C5's checklist while proving
nothing, in the same way that checking `MAX_RECEIPTS` after an unbounded read
would have satisfied B3's checklist while proving nothing. V4-B3 recorded a
blocked gap and built its prerequisite (V4-B3A) first. The same discipline
applies here.

Controlling verdict:

```text
V5_C5_EXTERNAL_CONFORMANCE_ENTRY_BLOCKED_GAP
```

`V5_IMPLEMENTATION_ENTRY: FAIL` is unchanged and is not re-decided by this audit.

## Authorized bounded successor: V5-C5A

One successor is authorized: **specify and distribute the receipt bundle format**,
so that an independent implementation becomes possible at all. It is
specification and packaging work only.

### Authorized scope

```text
specs/axiom-trust-protocol/0.1/schemas/trust-receipt-bundle.schema.json
specs/axiom-trust-protocol/0.1/RECEIPT-BUNDLE.md
specs/axiom-trust-protocol/0.1/examples/receipt-bundle.valid.json
specs/axiom-trust-protocol/0.1/examples/receipt-bundle.tampered-bundle-hash.json
specs/axiom-trust-protocol/0.1/examples/receipt-bundle.broken-chain.json
specs/axiom-trust-protocol/0.1/conformance/README.md
package.json
test/v5-c5a-receipt-bundle-spec.test.js
```

No ninth file. Any further owner is a stop condition requiring a source-backed
amendment.

### Required outcome

1. `RECEIPT-BUNDLE.md` specifies, in prose an independent implementer can follow
   without reading `lib/`: canonical receipt field set and ordering, the
   deterministic serialization rule, the per-receipt hash input including
   `previousReceiptHash`, the genesis value, the chain linkage rule, and
   `bundleHash` as the digest over the serialized receipt array.
2. The schema validates bundle envelope shape: `schemaVersion`, `workspaceId`,
   `exportedAt`, `receiptCount`, `bundleHash`, `receipts`.
3. The three examples are produced by the real export path, not hand-written, and
   the two negative examples differ from the valid one by exactly one mutation.
4. The test proves the examples match the schema, that the documented algorithm
   recomputes the recorded `bundleHash` for the valid example, and that each
   negative example fails the documented rule it targets.
5. `package.json` adds only the `specs/**` and `schemas/**` entries required to
   distribute the specification. No dependency, no other metadata change.
6. `conformance/README.md` stops presenting an in-repo unit test as conformance
   and states plainly that in-repo tests are self-tests, not interoperability
   evidence.

### Explicitly not authorized

- No runtime change. `lib/receipt/*`, `graph.js`, `kernel.js`, `server.js` and
  the B3 route are untouched; the bundle format is documented as it already
  behaves, never adjusted to make documentation easier.
- No new receipt format, version bump or schema migration.
- No ATP→HTP rename. That remains C2 (#274).
- No public-safe or redacted receipt. That remains C4 (#276).
- No external conformance runner, and no `V5-C5` completion claim.
- No dependency, including a JSON Schema validator library. If the test cannot
  validate the examples without one, record that as a stop condition rather than
  adding it here.

### Falsification conditions

Stop and emit `V5_C5A_RECEIPT_BUNDLE_SPEC_BLOCKED_GAP` if:

- the documented algorithm cannot reproduce `bundleHash` for a real exported
  bundle, which would mean the format is not deterministic as believed;
- specifying the format faithfully would require changing runtime behaviour;
- the canonical serialization depends on JavaScript-specific ordering that cannot
  be stated language-neutrally, since a spec an implementer cannot follow in
  another language is not a spec; or
- an unlisted file must change.

A blocked verdict is acceptable evidence and must not be hidden by weakening the
specification.

## What C5 needs after C5A

Recorded so the sequence is not rediscovered, and not authorized here:

1. **C5A** — publish and distribute the bundle specification (this pack).
2. **An independent verifier** that implements the published specification and
   imports nothing from `lib/`. Sharing a repository is acceptable; sharing an
   implementation is not.
3. **C2–C4** — the compatibility, exchange and public-safe deliverables whose
   fields C5's negative tests are written against.
4. **C5** — the runner itself, with a real external consumer and fail-closed
   coverage for invalid, tampered, missing-scope, missing-evidence and expired
   objects.

Only step 4 produces external interoperability evidence. Steps 1–3 are what make
step 4 mean something.
