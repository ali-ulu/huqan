# HUQAN Wiki

HUQAN is a local gate between what an AI agent proposes and the state that proposal would change: memory, repository state, tool execution, or other governed actions.

The core question is simple:

> **Should this specific output be trusted before it lands?**

HUQAN evaluates evidence, provenance, scope, risk, policy, and approval requirements before a governed mutation is allowed to become state. Every governed decision can leave a durable **Trust Receipt** describing what was evaluated, which boundary applied, and what happened.

## Start here

- [Getting Started](Getting-Started)
- [How HUQAN Works](How-HUQAN-Works)
- [Architecture](Architecture)
- [Trust Receipts](Trust-Receipts)
- [Approval & Human Oversight](Approval-and-Human-Oversight)
- [MCP & External Agent Integration](MCP-and-External-Agent-Integration)
- [Security Model](Security-Model)
- [Limits & Guarantees](Limits-and-Guarantees)

## The shortest mental model

```text
evidence + provenance + workspace scope
        -> verification, contradiction, risk
                -> policy and approval boundary
                        -> outcome + Trust Receipt
```

Possible outcomes depend on the gate. Across HUQAN surfaces they include:

```text
ALLOW / REVIEW / QUARANTINE / DRY-RUN ONLY / BLOCK / REJECT
```

A passing verification is **not** a certificate of truth. It is a decision made inside a configured boundary, and HUQAN is designed to preserve the evidence and policy context around that decision.

## Product surfaces

The repository currently distinguishes these surfaces:

1. **Public static 60-second demo** at `demo/index.html`. It is a backend-free simulation, not live HUQAN engine output.
2. **Local developer UI** at `public/index.html`, served by `node server.js`.
3. **Read-only Trust Receipt Viewer** at `/viewer` on the running local server.
4. **Docs entry surface** at `docs/index.html`.

See the canonical source: [docs/product-surfaces.md](https://github.com/ali-ulu/huqan/blob/main/docs/product-surfaces.md).

## Source of truth

This Wiki is an orientation and explanation layer. When a Wiki page and live source disagree, the repository wins.

Primary sources:

- [README](https://github.com/ali-ulu/huqan/blob/main/README.md)
- [Current Operating Roadmap](https://github.com/ali-ulu/huqan/blob/main/docs/current-operating-roadmap.md)
- [Security Policy](https://github.com/ali-ulu/huqan/blob/main/SECURITY.md)
- [Threat Model](https://github.com/ali-ulu/huqan/blob/main/THREAT_MODEL.md)
- [Product Surfaces](https://github.com/ali-ulu/huqan/blob/main/docs/product-surfaces.md)
- [Module Reachability](https://github.com/ali-ulu/huqan/blob/main/lib/module-reachability.js)

## One rule that explains the project

**Confidence is not truth. Verify before you trust.**
