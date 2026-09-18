# ADR 0005: Provenance accompanies every mutation

## Status
Accepted

## Context
HUQAN's trust model depends on being able to distinguish where durable information came from, what transformed it, and whether it was admitted as canonical. A value without provenance cannot support reliable audit or later trust decisions. Imported or model-produced material also must not become canonical merely because it entered the system.

## Decision
Every durable mutation carries provenance sufficient to identify its source and mutation path. Provenance is preserved through admission, mutation, receipt, and audit surfaces according to their contracts.

Untrusted input is evidence/candidate material, not canonical knowledge by default. Canonicalization occurs only through the applicable admission and trust policy. Missing provenance is handled explicitly according to policy; it is never silently fabricated.

## Consequences
- Mutations remain traceable to their source and decision path.
- Importing data does not implicitly confer trust.
- Adapters must propagate provenance instead of dropping it.
- Legacy data with incomplete provenance must remain distinguishable from fully evidenced records.

## References
- `lib/provenance-ingest.js`
- `lib/kernel-learn-admission.js`
- `docs/adr/ADR-012-audit-evidence-and-admission.md`
- Issue #2640 (A4)
