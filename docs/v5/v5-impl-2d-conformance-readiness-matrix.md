# V5-IMPL-2D - Shared Trust Package Conformance Readiness Matrix

**Current checkpoint:** `V5-IMPL-2D_SCOPE_DEFINITION_MERGED_DOCS_ONLY_GREEN`
**Canonical branch:** `main`
**Base HEAD:** `ce762c7820c4595997d541fefd54fb4a795b9fca`
**Mode:** Non-runtime conformance readiness artifact

## Purpose

This matrix makes the V5 Shared Trust Package contract chain visible and
auditable before any runtime package exchange work starts.

It maps the current package contract areas to their documentation, schema,
fixture, validator, and test coverage. It also records explicit gaps and the
future gates that must remain separate.

This PR does not implement package writing, package reading, signing,
verification runtime, A2A exchange, connector enforcement, marketplace
distribution, or AgentAction policy behavior.

## Matrix

| Contract area | Source document | Schema coverage | Fixture coverage | Validator coverage | Test coverage | Current status | Gap / future gate | Runtime claim allowed? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| package identity | `docs/v5/v5-shared-trust-package-format.md` | `packageId` required | valid and missing package id fixtures | `missing_required_field` on `packageId` | validator rejects missing package identity | covered | none before next conformance expansion | no |
| schema version | `docs/v5/v5-shared-trust-package-format.md` | `schemaVersion` const `v5-shared-trust-package/v0.1` | valid fixtures use current version | `invalid_schema_version` on unsupported versions | validator rejects unsupported schema versions | covered | version migration policy remains future work | no |
| issuer agent/workspace identity | `docs/v5/v5-agent-identity-contract.md` and `docs/v5/v5-shared-trust-package-format.md` | `issuer.agentId` and `issuer.workspaceId` required | valid fixtures include issuer identity | required string validation | covered through valid fixture and validator helper checks | covered | runtime identity enforcement remains future gate | no |
| route receipt metadata | `docs/v5/v5-shared-trust-package-format.md` | `receipt.routeReceipt` and top-level `routeReceipt` shapes | route receipt and route receipt chain fixtures | route receipt metadata and hop validation | validator rejects missing and malformed route receipt metadata | covered | cross-agent route verification remains future gate | no |
| reasoning metadata | `docs/v5/v5-shared-trust-package-format.md` | `reasoningMetadata.traceId` and `steps` shape | valid reasoning metadata fixture and runtime-claim invalid fixture | reasoning metadata shape and enum validation | validator rejects missing and malformed reasoning metadata | covered | private reasoning / chain-of-thought export remains forbidden | no |
| verdict metadata | `docs/v5/v5-shared-trust-package-format.md` | `verdict.status` enum: `allow`, `review`, `dry_run_only`, `block` | valid fixtures and missing verdict fixture | verdict enum and required field validation | validator rejects missing verdict status | covered | policy replay semantics remain future work | no |
| unsupported version failure | `docs/v5/v5-impl-2c-scope-definition.md` | schema const enforces current version | test mutates valid fixture to unsupported version | `invalid_schema_version` reason code | validator rejects unsupported schema versions | covered | compatibility matrix can expand later | no |
| invalid fixture failure | `docs/v5/v5-impl-2c-scope-definition.md` | additional properties are rejected | invalid fixtures cover missing fields and runtime claims | structured invalid result with code/path/message | invalid fixtures fail for intended reasons | covered | broader negative fixture set can expand later | no |
| deterministic repeated output | `docs/v5/v5-impl-2c-scope-definition.md` | not a schema field | deterministic fixture input | pure validator result for repeated calls | repeated validation returns identical result and does not mutate input | covered | property-based determinism proof remains future work | no |
| runtime writer | `docs/v5/v5-impl-2d-scope-definition.md` | intentionally not covered | no fixture claims writer support | no writer dependency | validator isolation test rejects runtime dependency | not_started | future runtime writer gate only after separate approval | no |
| runtime reader | `docs/v5/v5-impl-2d-scope-definition.md` | intentionally not covered | no fixture claims reader support | no reader dependency | validator isolation test rejects runtime dependency | not_started | future runtime reader gate only after separate approval | no |
| signing runtime | `docs/v5/v5-shared-trust-package-format.md` | placeholder only, no signing runtime schema | no fixture claims signing support | no signing dependency | validator isolation test checks no signing runtime dependency | not_started | future signing gate only after separate approval | no |
| verification runtime | `docs/v5/v5-shared-trust-package-format.md` | structural validation only | no fixture claims verification runtime | no verification runtime dependency | validator isolation test checks no verification runtime dependency | not_started | future verification runtime gate only after separate approval | no |
| A2A exchange | `docs/v5/v5-shared-trust-package-format.md` | intentionally not covered | no fixture claims A2A transport | no A2A dependency | validator isolation test checks no A2A dependency | not_started | future A2A transport gate only after separate approval | no |
| connector enforcement | `docs/v5/v5-connector-coverage-matrix.md` | intentionally not covered | no fixture claims connector enforcement | no connector enforcement dependency | validator isolation test checks no connector enforcement dependency | not_started | future connector enforcement gate only after separate approval | no |
| marketplace | `docs/v5/v5-marketplace-security-boundary.md` | intentionally not covered | no fixture claims marketplace readiness | no marketplace dependency | validator isolation test checks no marketplace dependency | not_started | future marketplace gate only after separate approval | no |

## Conclusion

`V5-IMPL-2D` improves conformance readiness visibility only.

The current Shared Trust Package line has structural coverage for the selected
fixture/schema/validator subset, including package identity, schema version,
issuer identity, route receipt metadata, reasoning metadata, verdict metadata,
invalid fixtures, unsupported versions, and deterministic repeated output.

The runtime and ecosystem layers remain explicitly out of scope:

- no runtime writer
- no runtime reader
- no signing runtime
- no verification runtime
- no A2A exchange
- no connector enforcement
- no marketplace
- no AgentAction policy engine

Any future runtime or ecosystem work must start from a separate approved gate.
