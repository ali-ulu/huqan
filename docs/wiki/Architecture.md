# Architecture

HUQAN is organized around a local trust decision pipeline rather than a single monolithic agent runtime.

## High-level layers

```text
Clients / agents / UI
        |
        v
Interfaces
CLI | MCP | REST | external-action guard | A2A
        |
        v
Policy and trust boundaries
verification | contradiction | risk | approval | action gates
        |
        v
State and evidence
memory | graph | provenance | receipts | replay / audit records
        |
        v
Local persistence and optional acceleration
SQLite / JSON stores | optional Rust graph acceleration
```

This diagram is intentionally conceptual. The live repository is the source of truth for exact module reachability.

## Canonical runtime

The package-level library entry resolves to **KernelV2**, which is the canonical runtime. Historical compatibility identifiers still exist in parts of the codebase and documentation; they do not represent a separate product.

## Interfaces

### CLI

The `huqan` binary is the primary operator/developer command-line surface.

### MCP

`huqan-mcp` exposes governed MCP interaction over stdio. Model-visible capabilities and operator-only capabilities are intentionally separated.

### REST / local UI

`server.js` serves the local HTTP/API surface, the backend-connected developer UI, and the read-only receipt viewer.

### External action guard

`huqan-gate` accepts a brand-independent action envelope before execution. Client-specific adapters translate local hook/event formats into that envelope.

### A2A

The repository includes deployment-gated A2A routes for bounded exchange, receiver identity advertisement, capability negotiation, and task lookup. They remain unserved until the required trust-root and replay configuration exists.

## Trust-critical subsystems

The security policy identifies these as part of the security-critical surface:

- kernel / KernelV2
- graph engine and memory stores
- MCP server and MCP gate adapter
- tool-call and action-risk gates
- memory mutation and automation safety gates
- REST verification/ingest endpoints
- verification, risk, contradiction and semantic scoring
- sandbox-related components
- plugin loader
- provenance, package and receipt formats
- CI/security configuration

## Product-surface separation

HUQAN deliberately distinguishes product/runtime surfaces:

- `public/index.html` — local backend-connected developer UI
- `/viewer` — read-only Trust Receipt Viewer served by the local server
- `docs/index.html` — documentation chooser/entry surface
- planned static public demo — currently absent from the repository

This avoids treating every HTML file as a competing product mode.

## Optional Rust acceleration

Rust acceleration is treated as an optimization boundary, not a second trust model. It must not become a path around policy, provenance, approval, or audit semantics.

## Module reachability matters

The repository explicitly distinguishes a green unit test from production reachability. Some modules can be tested successfully while remaining outside the production entry-point graph.

Use [lib/module-reachability.js](https://github.com/ali-ulu/huqan/blob/main/lib/module-reachability.js) and the current roadmap when judging whether a capability is merely implemented, wired, deployment-gated, or actually part of a live path.

## Canonical references

- [Product Surfaces](https://github.com/ali-ulu/huqan/blob/main/docs/product-surfaces.md)
- [Security Policy](https://github.com/ali-ulu/huqan/blob/main/SECURITY.md)
- [Current Operating Roadmap](https://github.com/ali-ulu/huqan/blob/main/docs/current-operating-roadmap.md)
- [Module Reachability](https://github.com/ali-ulu/huqan/blob/main/lib/module-reachability.js)
