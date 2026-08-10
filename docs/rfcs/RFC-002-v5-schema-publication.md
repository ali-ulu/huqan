# RFC-002 — V5 JSON Schema Publication Contract

**Status:** `ACCEPTED` — publication decision only. Implementation belongs to
M3 (issue #607).

**Gate:** V5-C5 prerequisite (issue #619)

## Summary

V5 protocol JSON artifacts are published from
`specs/huqan-trust-protocol/0.2/`. The existing
`specs/axiom-trust-protocol/0.1/` tree remains the frozen legacy ATP lineage and
is not extended with V5 artifacts.

The canonical spec tree is authoritative. `schemas/v5/` remains a repo-internal
working mirror, not a package facade. M3 must keep every published JSON artifact
byte-identical between the canonical tree and its working mirror with a
mechanical drift test.

This RFC changes no file layout, package allowlist, runtime behavior, validator,
or conformance result. Those changes require #607 and the subsequent #277
re-validation.

## Decisions

### 1. Version directory

The first canonical HUQAN Trust Protocol publication that contains the existing
V5 JSON contracts is:

```text
specs/huqan-trust-protocol/0.2/
```

`0.2` is the protocol publication lineage, not a claim that product V5 is
complete. ATP `0.1` remains valid indefinitely at its existing path. No V5 file
may be added below the ATP `0.1` tree.

### 2. Canonical source and drift prevention

The files below `specs/huqan-trust-protocol/0.2/` are authoritative after M3.
Any corresponding file below `schemas/v5/` is a working mirror only.

M3 must:

- name the complete, literal set of published JSON artifacts;
- place each artifact in the canonical spec tree and npm package allowlist;
- keep the working mirror byte-identical to the canonical file;
- add a test that fails when any artifact in the literal publication manifest
  is missing or byte-different in either location;
- reject a JSON artifact in the canonical publication directory when it is not
  named by that manifest, without treating repo-internal JSON outside the
  manifest as a mirror or publication candidate; and
- keep the package allowlist literal. Globs are not permitted.

The initial publication includes these existing protocol artifacts:

- `a2a-trust-evidence.schema.json`;
- `public-trust-receipt.schema.json`;
- `public-receipt-redaction-policy.json`;
- `shared-trust-package.schema.json`; and
- `agent-identity.schema.json`.

Other JSON material is not implicitly public because it exists in
`schemas/v5/`. Adding it requires an explicit RFC amendment or later version.

The current `https://huqan.local/schemas/v5/...` identifiers are unpublished
working locators, not canonical public identifiers. M3 must replace each schema
identifier in both canonical files and mirrors with this exact form:

```text
https://huqan.dev/specs/huqan-trust-protocol/0.2/schemas/<filename>
```

This is not a change to ATP `0.1` identifiers or wire values.

`public-receipt-redaction-policy.json` must set `canonicalizationSource` to
`specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md`. The canonical document must
reuse the existing ATP `0.1` canonical JSON algorithm without redefining or
changing it; the new locator identifies its canonical HUQAN publication.

### 3. Freeze semantics

The `0.2` directory becomes frozen when an npm package or tagged release first
ships it. From that point:

- published JSON bytes and canonical identifiers are immutable;
- a contract change, including a backward-compatible schema edit, requires a
  new protocol version directory; and
- prose errata may clarify behavior only when they do not alter a published
  JSON artifact or its validation result.

Before first publication, #607 may make only the transformations required by
this RFC and must prove the final canonical and mirror files are identical.

### 4. Validator boundary

The public surface is data and specification, not runtime code. The following
JavaScript files remain repo-internal and `NOT_YET_WIRED`:

- `*-validator.js`;
- `*-conformance.js`;
- `*-coverage.js`;
- `*-readiness.js`.

`shared-trust-package-conformance-matrix.json` also remains repo-internal and
unpublished, but it is not a `NOT_YET_WIRED` code entry.

M3 must prove these files are absent from the canonical publication and packed
package. Publishing or wiring validator code requires a separate gate.

## Facade and compatibility constraints

- The top-level `schemas/` directory remains forbidden by
  `test/kernel-facade-contract.test.js`.
- `package.json` must publish only literal canonical spec paths.
- `specs/axiom-trust-protocol/0.1/` remains present and unchanged.
- Existing ATP receipts, bundles, examples, schemas, and `$id` values remain
  valid.
- The legacy Python verifier continues to run from its ATP `0.1` path.

This RFC does not authorize relaxing a facade rule to make publication easier.

## Implementation and evidence ownership

Issue #607 owns all implementation: canonical directories, JSON publication,
identifier changes for the previously unpublished V5 working files, literal
allowlist entries, and drift/packaging tests.

M3 is not complete until it proves:

1. canonical and working JSON copies are byte-identical;
2. the packed package contains the exact canonical JSON set;
3. top-level `schemas/` and validator code remain absent from the package;
4. legacy ATP `0.1` content and verifier still work; and
5. the C5 external runner passes against both canonical and legacy surfaces.

After #607, issue #277 owns replacing all three `BLOCKED_GAP` records with real
package-validation, C3/C4 compatibility, and missing
scope/evidence/expiry-negative conformance cases. A green legacy-only run does
not satisfy this requirement.

## What this RFC does not do

- It does not copy, move, rename, or publish a schema.
- It does not edit `package.json` or relax the package facade.
- It does not publish or wire a JavaScript validator.
- It does not change ATP `0.1` or a published legacy identifier.
- It does not close #607 or #277.
- It does not claim V5, interoperability, or production readiness.

## Outcome

The dependency is unambiguous:

```text
RFC-002 decision (#619)
  -> canonical publication implementation (#607)
  -> canonical + legacy C5 re-validation (#277)
```
