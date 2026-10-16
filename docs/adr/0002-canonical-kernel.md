# ADR 0002: Canonical Kernel export

## Status
Accepted

## Context
HUQAN has accumulated Kernel and KernelV2 surfaces. Two peer kernel implementations make ownership of admission, learning, provenance, and mutation behavior ambiguous and allow fixes to land in only one path.

## Decision
`Kernel` is the canonical public kernel contract. `kernel.v2` is a compatibility/migration facade and must not become a second owner of core behavior. V2-specific policy may prepare inputs or decorate compatibility results, but canonical learning, admission, provenance, conflict handling, and mutation behavior delegate to the single Kernel-owned path.

Migration removes duplicated V2 behavior incrementally behind characterization tests. New core behavior belongs in the canonical implementation or a shared policy module called by it, not in a peer kernel.

## Consequences
- One implementation owns canonical kernel semantics.
- Compatibility can be preserved while duplicated V2 logic is retired.
- Refactors require characterization tests so migration does not become a behavior rewrite.
- Public callers should migrate toward the canonical `Kernel` export.

## References
- `kernel.js`
- `kernel.v2.js`
- `lib/kernel-learn-admission.js`
- `docs/adr/ADR-013-kernel-v2-substitutability.md`
- Issues #2117 and #2640
