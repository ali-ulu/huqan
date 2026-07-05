# V5 Conformance Suite Fixture Plan

## Status

Planning only.

This document defines fixture categories, expected pass/fail semantics, naming
rules, future runner boundaries, and non-claims for the V5 conformance suite.

It does not implement fixture JSON files, schema files, validators, runtime
tests, a conformance runner, package generation, runtime enforcement, or
marketplace behavior.

## Purpose

The V5 conformance suite exists to make future shared trust claims testable
without overstating current implementation.

Its role is to eventually verify:

- Agent Identity Contract shape
- Shared Trust Package structure
- Route Receipt parent/child consistency
- Reasoning Metadata boundaries
- non-trust-by-default behavior for external packages
- privacy and provenance discipline before ecosystem claims

The suite is a planning gate for future compatibility. It is not a current
runtime guarantee.

## Fixture Categories

The planned fixture groups are:

- `agent_identity_valid`
- `agent_identity_invalid`
- `shared_trust_package_valid`
- `shared_trust_package_invalid`
- `route_receipt_valid`
- `route_receipt_invalid`
- `reasoning_metadata_valid`
- `reasoning_metadata_invalid`
- `provenance_linkage_valid`
- `provenance_linkage_invalid`
- `revocation_expiry_cases`
- `tamper_detection_cases`
- `privacy_boundary_cases`
- `non_claims_claim_discipline_cases`

## Category Intent

| Category | Purpose |
| --- | --- |
| `agent_identity_valid` | Proves a package can reference a structurally valid identity envelope. |
| `agent_identity_invalid` | Proves missing, revoked, expired, or mismatched identity fails closed. |
| `shared_trust_package_valid` | Proves a package can be structurally valid without implying trust-by-default. |
| `shared_trust_package_invalid` | Proves malformed or incomplete package envelopes are rejected. |
| `route_receipt_valid` | Proves route/hop receipts can preserve parent/child integrity. |
| `route_receipt_invalid` | Proves route chain mismatch or broken delegation invalidates the package. |
| `reasoning_metadata_valid` | Proves bounded deterministic metadata is acceptable. |
| `reasoning_metadata_invalid` | Proves hidden chain-of-thought, secrets, or private memory leaks are invalid. |
| `provenance_linkage_valid` | Proves canonical claims must include matching provenance references. |
| `provenance_linkage_invalid` | Proves missing or mismatched provenance invalidates canonical-claim packages. |
| `revocation_expiry_cases` | Proves revoked or expired identity/policy/package states are not silently accepted. |
| `tamper_detection_cases` | Proves hash, route, or evidence tampering is rejected. |
| `privacy_boundary_cases` | Proves private memory and connector payloads cannot leak through fixtures. |
| `non_claims_claim_discipline_cases` | Proves fixtures and reports cannot overclaim implementation or readiness. |

## Fixture Naming Convention

Fixtures should use deterministic, explicit names.

Examples:

- `agent_identity.valid.minimal.json`
- `agent_identity.invalid.missing_agent_id.json`
- `agent_identity.invalid.expired_identity.json`
- `shared_package.valid.minimal.json`
- `shared_package.invalid.missing_receipt_bundle.json`
- `route_receipt.valid.single_hop.json`
- `route_receipt.invalid.parent_mismatch.json`
- `reasoning_metadata.valid.rule_ids_only.json`
- `reasoning_metadata.invalid.hidden_chain_of_thought.json`
- `package.invalid.external_trusted_by_default.json`
- `package.invalid.private_memory_leak.json`

Naming goals:

- category first
- valid/invalid state explicit
- failure reason visible in filename
- deterministic and grep-friendly

## Expected Result Model

Each future fixture should define planned expectation fields such as:

- `fixture_id`
- `fixture_type`
- `expected_status`
- `expected_reason_code`
- `expected_verdict`
- `expected_errors`
- `expected_warnings`
- `future_test_name`

Expected statuses:

- `valid`
- `invalid`
- `review_required`
- `rejected`
- `expired`
- `revoked`
- `tampered`
- `privacy_violation`

## Expected Result Intent

| Field | Purpose |
| --- | --- |
| `fixture_id` | Stable identifier for the fixture case. |
| `fixture_type` | Group or semantic type of the fixture. |
| `expected_status` | Deterministic expected result. |
| `expected_reason_code` | Stable reason code for reject/review outcomes. |
| `expected_verdict` | High-level action expectation such as allow, review, or block when relevant. |
| `expected_errors` | Structured errors expected from validation. |
| `expected_warnings` | Structured warnings allowed when a case is reviewable rather than outright invalid. |
| `future_test_name` | Planned test or fixture runner mapping for later implementation. |

## Pass / Fail Semantics

The future conformance program should preserve these semantics:

- a structurally valid package can still be untrusted
- an external package cannot become canonical by default
- missing identity invalidates the package
- revoked identity rejects the package
- expired identity requires reject or review
- route parent mismatch invalidates the route chain
- hidden reasoning export is invalid
- private memory leak is invalid
- missing provenance invalidates canonical-claim packages
- unknown `policy_version` requires review or reject

This means "valid" and "trusted" are not synonyms.

## Relationship To Existing V5 Documents

This plan maps back to:

- `V5-PR0` Shared Trust / Ecosystem Blueprint
- `LIT-0` source discipline
- `V5-PR1` Agent Identity Contract
- `V5-PR2` Shared Trust Package / Route Receipt / Reasoning Metadata plan
- future Connector Coverage Matrix
- future Marketplace Security Boundary

The conformance suite exists to connect these plans later through fixtures and
deterministic expected outcomes. It does not replace those contracts.

## Future Runner Boundary

The future conformance runner is not implemented here.

A later runner may:

- load fixture JSON
- validate structure
- validate expected result
- compare reason codes
- produce a conformance report

This PR only defines fixture planning and expected semantics.

## Fixture Discipline

Fixture data may be used only when explicitly labeled as conformance fixtures.

Fixtures must not be presented as:

- production telemetry
- live connector evidence
- marketplace readiness proof
- public certification proof
- implementation completeness proof

## Non-Claims

This PR does not claim:

- Conformance Suite is implemented
- fixture JSON files are required or shipped by this PR
- runtime test runner is added
- validator is added
- schema implementation is added
- package compatibility certification exists
- marketplace readiness exists
- production-ready conformance program exists
- all-agent or all-connector compatibility exists
- V5 implementation is complete

## Next Gates

This document supports the following planning order:

1. `V5-PR3` - Conformance Suite fixture plan
2. `V5-PR4` - Connector Coverage / Identity + Package Enforcement Matrix
3. `V5-PR5` - Trust-tier routing plan
4. `V5-PR6` - A2A / Distributed Trust research note
5. `V5-IMPLEMENTATION-READINESS-0` - implementation gate audit

Anything beyond this remains future planning, not current implementation.

## Safe Claim

Safe current wording:

```txt
HUQAN has opened a conformance fixture planning gate for future shared trust
compatibility checks.
```

Unsafe wording:

```txt
HUQAN already has a production-ready conformance suite.
HUQAN certifies all shared trust packages.
HUQAN provides marketplace-ready compatibility badges.
HUQAN already runs a full conformance runner.
```
