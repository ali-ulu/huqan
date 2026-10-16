# ADR 0001: Local-first architecture

## Status
Accepted

## Context
HUQAN is a knowledge, memory, provenance, and trust system whose core guarantees must remain available when a network service is unavailable. Making a hosted service mandatory for canonical storage or trust decisions would turn connectivity into a correctness dependency and weaken user control over local evidence.

## Decision
HUQAN is local-first. Canonical knowledge, memory, provenance, receipts, and policy evaluation must have an offline-capable local path. Cloud services may add synchronization, acceleration, collaboration, or optional model capabilities, but the core runtime must not require them to open, inspect, validate, or mutate a local workspace according to policy.

Network integrations are adapters at explicit boundaries. Failure or absence of an optional remote dependency must degrade that capability explicitly rather than silently changing canonical local semantics.

## Consequences
- Core workflows remain usable without required cloud dependencies.
- Local data and evidence remain inspectable under user control.
- Remote features must define failure, retry, and reconciliation behavior.
- Some capabilities may be less powerful offline, but loss of connectivity cannot redefine trust semantics.

## References
- `lib/`
- `lib/storage/`
- `lib/memory-admission-gate.js`
- Issue #2640 (A4)
