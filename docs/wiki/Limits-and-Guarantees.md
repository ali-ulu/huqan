# Limits & Guarantees

HUQAN deliberately documents what it does **not** prove. This page collects those boundaries so users do not mistake a local trust decision for a universal guarantee.

## HUQAN does not eliminate hallucinations

HUQAN can make a governed output inspectable, reviewable and blockable before it becomes state.

It does not guarantee that an LLM never hallucinates or that a verified claim is universally true.

## Unconnected agents are not governed

HUQAN only governs paths that actually pass through its gate.

If an external agent executes without calling `huqan-gate`, MCP integration, a wrapper, gateway or equivalent pre-execution boundary, HUQAN does not retroactively control that action.

## Tested does not mean production-wired

The repository explicitly tracks module reachability. A module can have green unit tests while remaining outside the production entry-point graph.

Use live source and `lib/module-reachability.js` before claiming a capability is active in a production path.

## A2A is deployment-gated

The repository contains bounded A2A transport and conformance evidence. The routes remain absent (`404`) when the required deployment authority and replay configuration are not present.

The current repository documentation explicitly states that third-party interoperability has **not** been established merely by local conformance and deployment-smoke tests.

## Plugin authenticity is not plugin confinement

A signed plugin is authenticated, not sandboxed.

Because plugins execute in-process, installing a plugin grants it the host privileges available to the HUQAN process. Hash/signature verification does not restrict runtime behavior.

## Trust Receipts are bounded evidence

A Trust Receipt records a decision under a specific boundary. It is not a universal truth certificate.

Internal/full receipt artifacts should not automatically be treated as public-safe export formats.

## HUQAN complements other controls

HUQAN does not replace:

- IAM
- application security
- infrastructure security
- sandboxing
- host hardening
- human governance
- model evaluation systems

It governs a different question: whether a specific output or action should be trusted to land under the configured local policy.

## Product-surface limits

The repository currently has a backend-connected local UI and a read-only receipt viewer. A public static demo is documented as planned but absent.

Do not advertise a static deployable product surface that is not actually present in source.

## Scale claims

Repository evidence should be used as the limit of any benchmark or scalability claim. Local benchmarks do not justify claims of universal or internet-scale performance unless the repository contains reproducible evidence for that scale.

## Source-of-truth rule

When a Wiki summary, old issue, design note or marketing description disagrees with live source and current repository evidence, the repository wins.

Useful references:

- [README](https://github.com/ali-ulu/huqan/blob/main/README.md)
- [Current Operating Roadmap](https://github.com/ali-ulu/huqan/blob/main/docs/current-operating-roadmap.md)
- [Module Reachability](https://github.com/ali-ulu/huqan/blob/main/lib/module-reachability.js)
- [Product Surfaces](https://github.com/ali-ulu/huqan/blob/main/docs/product-surfaces.md)
- [Threat Model](https://github.com/ali-ulu/huqan/blob/main/THREAT_MODEL.md)
