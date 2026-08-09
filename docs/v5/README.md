# HUQAN / AXIOM V5 Planning

This directory contains V5 Shared Trust / Ecosystem planning and bounded
contract artifacts. Its existence does not authorize V5 ecosystem runtime.

The controlling entry decision is:

- [`ADR-010 - V5 Ecosystem Boundary and Entry Audit`](../adr/ADR-010-v5-ecosystem-entry.md)

While ADR-010 is controlling:

```text
V5_IMPLEMENTATION_ENTRY: FAIL
```

A successor source-backed entry audit must record PASS before V5 ecosystem
implementation is authorized.

## Source Authority

Live source, tests, exact Git SHA and current CI evidence outrank this planning
index. `docs/current-operating-roadmap.md` and the controlling ADR must be read
before using older V5 planning statements as current status.

The original V5 planning set was opened against an earlier V4 checkpoint. That
historical planning decision is not evidence that the current V4 final closeout
or external interoperability entry gate has passed.

## Current Boundary

```text
V4 = local/workbench trust runtime + product-runtime evidence
V5 = portable/external trust exchange + interoperability evidence
```

Current live source includes bounded V5 writer/reader/verification modules, but
the production connector reconciliation classifies those modules as
library-only and does not show end-to-end V5 identity/package enforcement on a
production connector path.

V5 planning may describe future contracts. Planning is not implementation,
production reachability, external interoperability or ecosystem readiness.

## Artifact Status Vocabulary

Use the ADR-010 meanings consistently:

- `draft` - exploratory/illustrative planning, not a binding runtime contract;
- `spec` - accepted deterministic contract or decision;
- `implementation` - executable code exists; reachability is stated separately;
- `future` - intentionally not authorized or not yet implemented.

`implementation` must not be used as shorthand for `production-reachable` or
`externally interoperable`.

## Documents

- [Shared Trust / Ecosystem Blueprint](./v5-shared-trust-ecosystem-blueprint.md)
- [Agent Identity Contract](./v5-agent-identity-contract.md)
- [Shared Trust Package Format](./v5-shared-trust-package-format.md)
- [Conformance Suite Plan](./v5-conformance-suite-plan.md)
- [Marketplace Security Boundary](./v5-marketplace-security-boundary.md)
- [Connector Coverage Matrix](./v5-connector-coverage-matrix.md)
- [Trust-tier Routing Plan](./v5-trust-tier-routing-plan.md)
- [A2A / Distributed Trust Research Note](./v5-a2a-distributed-trust-research-note.md)

## Naming Boundary

ATP/Axiom remains the current source-backed protocol/package lineage. This
planning index does not rename or migrate ATP to HTP. Any HTP naming and
compatibility decision requires its separately reviewed compatibility RFC.

## Marketplace Boundary

Marketplace behavior remains deferred. No public marketplace, badge launch,
public reputation economy or package bazaar is authorized by this planning set.

## Non-Claims

This planning set does not claim:

- V4 final closeout is complete;
- V5 implementation entry has passed;
- V5 implementation is complete;
- HUQAN is a production-ready full control plane;
- HUQAN guarantees truth or eliminates hallucinations;
- all connector/client paths are V5-enforced;
- local fixtures/tests prove external interoperability;
- Shared Trust Package import/export is production-reachable;
- public receipt exchange, A2A exchange, GitHub App or Streaming Trust is
  production-ready;
- marketplace security, public badges or reputation economy is implemented;
- ATP has been renamed or migrated to HTP.
