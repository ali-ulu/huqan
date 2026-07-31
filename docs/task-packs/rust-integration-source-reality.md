# Rust Integration Source Reality

## Checkpoint

- Repository: `ali-ulu/huqan`
- Source base: `main @ ed2e267a5d0ee74932eab36f6df8aa59066bc591`
- Previous checkpoint: `V4_PRIMITIVES_GREEN_PRODUCT_UI_OPEN`
- Decision: `RUST_DEFERRED`
- Mode: source-reality and decision only

This task-pack records the current Rust/Axiom Core integration boundary. It
does not authorize compilation, binary distribution, Kernel wiring, API
changes, or performance claims.

## Source authority

Use this order when evidence conflicts:

1. live source and reachable production call paths at the pinned base;
2. executable tests with their real skip/pass status;
3. current architecture and roadmap documents;
4. historical Rust experiments, dashboards, or performance claims.

The Graphify report is stale relative to this base. The decision therefore uses
the pinned source and the current codebase-memory graph.

## Tracked Rust artifacts

The repository contains:

- a Rust binary crate under `axiom-core`;
- a JSON-line command loop in `axiom-core/src/main.rs`;
- a Node wrapper in `rustGraph.js`;
- an optional binary-detection branch in `kernel.js`;
- a RustGraph comparison test gated by a local release executable.

These artifacts establish experimental source availability. They do not
establish production integration.

## Production reachability

At the pinned base:

- Kernel may assign `this._rust = new RustGraph()` when a specific binary path
  is detected;
- after a successful learn, the learn use case may call `this._rust.learn(text)`
  as a fire-and-forget mirror and log an asynchronous error;
- the normal Kernel graph remains the JavaScript `Graph`;
- RustGraph falls back to a separate JavaScript Graph when the binary is
  unavailable or cannot be started;
- the wrapper is asynchronous while the normal Graph contract is synchronous.

The current source therefore mirrors one learn signal opportunistically. Rust
is not the authoritative Kernel graph, does not replace normal JavaScript Graph
behavior, and does not control the learn result.

## Build and distribution boundary

The current build script targets a local Windows GNU toolchain and a fixed
`x86_64-pc-windows-gnu` release executable path.

The release binary is not tracked. The target directory is ignored. No package
install, release asset, platform matrix, checksum, signature, or updater
contract distributes the executable.

No supported Linux, macOS, MSVC, container, or npm-install binary path is
established.

## Test reality

At the pinned base:

`node --test rustGraph.test.js`

reports the RustGraph comparison suite as skipped because the expected local
binary is absent. Zero Rust parity test cases execute.

This is not a passing parity proof.

## Known parity gaps

Current wrapper behavior is not ready to be treated as a Graph replacement:

- Rust-path `query()` does not expose normal Graph query behavior;
- Rust-path `save()` and `load()` do not establish JavaScript persistence
  parity;
- lifecycle, error, restart, timeout, and backpressure behavior is not locked;
- fallback behavior is not a production safety proof;
- no Kernel path proves equal verdict, receipt, audit, workspace, or admission
  semantics.

## Decision

`RUST_DEFERRED`

Do not wire the Rust wrapper into Kernel behavior now.

Reasons:

1. No accepted product path identifies a performance bottleneck that requires
   Rust.
2. The reachable learn mirror is fire-and-forget and is not an authoritative
   Kernel execution path.
3. The binary lacks a supported build and distribution contract.
4. The comparison suite executes no parity cases without an untracked local
   binary.
5. Sync/async and persistence differences make a mechanical substitution
   unsafe.
6. The smallest correct implementation is to keep the experimental source
   isolated until a measured need and one bounded public path exist.

## Required future trigger

Open a Rust integration chain only when all of these are named:

- a measured JavaScript bottleneck;
- one exact Kernel public operation to accelerate;
- accepted latency or throughput target;
- supported platform and binary distribution method;
- fallback and failure policy;
- persistence and workspace semantics;
- parity test ownership.

Do not use a repository-wide "move high-performance logic to Rust" goal as an
implementation contract.

## Minimum future proof

A future Rust integration gate must prove:

1. a reproducible binary build on the supported platform;
2. checksum or signature verification for the distributed binary;
3. exact result and error parity for one bounded Kernel operation;
4. workspace, persistence, admission, audit, verdict, and receipt parity where
   that operation touches them;
5. lifecycle behavior for start, timeout, crash, restart, and shutdown;
6. explicit fail-closed or fallback behavior;
7. the JavaScript path remains available until parity and rollback evidence is
   complete;
8. a benchmark demonstrates the measured target without changing semantics.

## Non-claims

This decision does not claim:

- a built or distributed Rust binary;
- Rust/JavaScript behavior parity;
- production Kernel offload;
- deterministic execution through Rust;
- persistence or fallback safety;
- a performance improvement;
- causal-simulator integration;
- V4, V5, ecosystem, or trust-network completion.
