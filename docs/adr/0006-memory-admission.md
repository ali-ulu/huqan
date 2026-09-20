# ADR 0006: Memory writes pass through the admission gate

## Status
Accepted

## Context
Memory is durable state. Multiple write paths that can bypass policy would make trust, workspace isolation, provenance, and approval guarantees dependent on which caller happened to perform the write.

## Decision
All production memory writes pass through the canonical memory admission decision, `evaluateMemoryAdmission`, directly or through a documented adapter that delegates to it. Callers may build context-specific admission requests, but they do not reimplement or bypass the policy decision.

Any narrowly scoped internal bypass needed for migration, recovery, or testing must be explicit, non-default, documented, and covered by tests. Adding a new memory-writing surface requires demonstrating how it reaches the admission gate before it can become production-capable.

## Consequences
- Memory policy has one enforceable choke point.
- Workspace, provenance, and approval rules cannot vary accidentally by write path.
- New adapters must preserve the inputs needed by the admission decision.
- Recovery and migration tooling must make exceptional paths visible rather than silently bypassing policy.

## References
- `lib/memory-admission-gate.js`
- `lib/kernel-learn-admission.js`
- `lib/error-prevention/admission.js`
- `docs/adr/ADR-005-v3-approval-runtime-and-memory-admission.md`
- Issue #2640 (A4)
