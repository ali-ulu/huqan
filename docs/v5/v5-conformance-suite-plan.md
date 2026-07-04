# V5 Conformance Suite Plan

## Status

Planning only. No conformance tests or fixtures are implemented by this
document.

## Purpose

The V5 conformance suite will eventually prove that shared trust packages,
agent identities, connector coverage labels, and receipt bundles obey HUQAN
trust boundaries.

## Future Test Classes

The suite should include tests for:

- valid receipt bundle
- invalid receipt bundle
- missing provenance
- stale policy version
- agent identity mismatch
- connector coverage mismatch
- tampered evidence hash
- unknown producer
- no-mock fixture discipline

## Expected Verdicts

| Scenario | Expected status |
| --- | --- |
| valid receipt bundle | valid |
| invalid receipt bundle | invalid |
| missing provenance | invalid |
| stale policy version | review or invalid |
| agent identity mismatch | invalid |
| connector coverage mismatch | invalid |
| tampered evidence hash | invalid |
| unknown producer | review or invalid |
| no-mock fixture violation | invalid |

## Fixture Discipline

Fixtures may be used only when explicitly labeled as conformance fixtures.

Fixtures must not be presented as:

- production telemetry
- live connector evidence
- public release proof
- marketplace readiness proof

## Future Gates

V5-PR3 may define fixture files and a test harness plan. Runtime conformance
execution remains a later implementation gate.

## Non-Claims

This document does not claim:

- conformance suite implementation exists
- packages are currently certifiable
- marketplace badges are ready
- V5 implementation is complete
