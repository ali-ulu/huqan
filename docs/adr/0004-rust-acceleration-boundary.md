# ADR 0004: Rust acceleration is behind a port

## Status
Accepted

## Context
HUQAN can use a native Rust graph accelerator (`rustGraph`). Treating the accelerator as a peer domain module would let native implementation details define core semantics and create a second architectural authority.

## Decision
The Rust accelerator is a backend implementation behind an explicit port owned by the relevant Knowledge/Memory boundary. JavaScript domain behavior defines the contract; native code may accelerate that contract but may not become a peer source of business semantics.

Callers depend on the port, not directly on native internals. Availability of the accelerator is optional: absence or failure follows the defined fallback/degradation behavior and must not silently change correctness rules.

## Consequences
- Native acceleration can evolve without coupling domain callers to Rust internals.
- A non-native implementation remains available for portability and testing.
- Contract/conformance tests must cover parity across implementations where both exist.
- Native-only behavior requires an explicit contract decision before adoption.

## References
- `rustGraph.js`
- `huqan-core/`
- Issue #2209
- Issues #2446 and #2640
