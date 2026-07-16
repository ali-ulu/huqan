# Kernel Facade Contract

Status: Contract scope for `REFACTOR-0C_KERNEL_FACADE_CONTRACT`.

Canonical base: `main @ 55b931ab58c3ede7b7af273d5fc1baaa82ddd4a1`

## Purpose

This document freezes the externally visible Kernel facade before any
mechanical refactor of `kernel.js` is considered.

The first refactor gate does not split `kernel.js`, change runtime behavior,
rename methods, move storage ownership, or alter result envelopes. It records
the compatibility surface that existing consumers can rely on and gives future
refactor work a contract to test against.

## Canonical Entry Points

- Package library entry point: `kernel.js`
- Type surface: `kernel.d.ts`
- CLI entry point: `cli.js`

`require('..')` from a package consumer must resolve to the same Kernel
constructor exported by `kernel.js`.

## Frozen Facade Methods

The canonical high-level Kernel facade includes:

- `learn`
- `ask`
- `verify`
- `reason`
- `compare`
- `dream`
- `detectGaps`
- `detectContradictions`
- `entropy`
- `consolidate`
- `selfEvolve`
- `startAutoThink`
- `stopAutoThink`
- `usePlugin`

These methods must remain callable on a Kernel instance unless a later gate
explicitly changes the contract.

## Static Exports

The Kernel constructor must expose:

- `CONTRACT_VERSION`
- `AXIOM_ERROR`

Instance `contractVersion` must match `Kernel.CONTRACT_VERSION`.

## Compatibility Surfaces

The current Kernel instance exposes `graph` and `memory`. They are compatibility
surfaces because existing code can observe them today.

This contract does not bless direct `graph` or `memory` mutation as a stable
extension API. New consumers should use the Kernel facade where possible. Any
future restriction, adapter layer, or migration of these surfaces must be
covered by a separate gate and must preserve existing behavior until that gate
explicitly authorizes otherwise.

## Non-Claims

- No `kernel.js` change.
- No `kernel.d.ts` change.
- No runtime behavior change.
- No method rename or removal.
- No new verdict, receipt, or envelope shape.
- No package metadata or dependency change.
- No MCP, CLI, graph, memory-store, schema, fixture, or V5 change.

## Stop Conditions

Stop and open a narrower alignment gate if:

- `require('..')` does not resolve to the Kernel constructor.
- The runtime Kernel facade contradicts `kernel.d.ts`.
- A required facade method is missing.
- `graph` or `memory` cannot be observed without changing runtime behavior.
- Contract testing requires modifying runtime code.
