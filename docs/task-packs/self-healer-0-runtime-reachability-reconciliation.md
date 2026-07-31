# SELF-HEALER-0 - Runtime Reachability Reconciliation

## Checkpoint

- Repository: `ali-ulu/huqan`
- Source base: `main @ 0eb1fec74a94b2531e4d6c316a405d4537b8da59`
- Previous checkpoint: post-trust-boundary roadmap reconciliation
- Decision: `DEFER_SELF_HEALER_PRODUCTION_ENTRYPOINT`
- Mode: source-reality and decision only

This task-pack reconciles the implemented Self-Healer library modules with
their actual runtime reachability. It does not authorize a scanner, production
entry point, write mode, patch generator, or pull-request workflow.

## Source authority

Use this order when evidence conflicts:

1. live source and reachable production call paths at the pinned base;
2. current executable tests;
3. `ADR-007`;
4. current Self-Healer contracts and roadmaps;
5. historical or superseded Self-Healer documents.

The `huqan_current` MCP did not provide runtime reachability evidence during
this review. The decision is based on the pinned source, code graph, and
targeted tests.

## Implemented library surface

The current aggregate module exports:

- finding schema normalization and validation;
- deterministic finding identifiers;
- deterministic heuristic classification of caller-supplied raw findings;
- an `audit_only` report helper for caller-supplied checks.

The audit helper validates bounded options, normalizes supplied findings, and
returns a report. It does not inspect a repository or discover findings by
itself.

## Reachability

At the pinned base:

- `runSelfHealerAudit()` is called by its direct test suite;
- no CLI command calls it;
- no HTTP route calls it;
- no MCP tool calls it;
- no scheduler or agent runtime calls it;
- no package script exposes it as an operational workflow.

The current implementation is therefore a tested library building block, not
a production-reachable Self-Healer product surface.

## Existing proof

The focused Self-Healer tests prove:

- finding schema and canonical identifier behavior;
- deterministic classification of supplied findings;
- `audit_only` mode validation;
- forbidden proposal and draft modes;
- deterministic report identifiers;
- repository traversal rejection;
- no filesystem, memory, branch, patch, or pull-request write behavior.

Those tests do not prove production reachability, repository scanning, test
execution, Git inspection, receipt emission, or mutation safety.

## Documentation conflict

The root README describes runtime Self-Healer work as planned. `ADR-007` and
the current source show that a partial audit-only library already exists.

The accurate statement is:

> HUQAN contains tested Self-Healer finding and audit-only library primitives,
> but no production entry point, autonomous scanner, or write workflow.

This gate records that source reality. A later docs-only cleanup may update the
README without changing runtime behavior.

## Decision

`DEFER_SELF_HEALER_PRODUCTION_ENTRYPOINT`

Do not add a CLI, HTTP, MCP, scheduler, or agent-runtime entry point now.

Reasons:

1. No accepted product workflow currently identifies who supplies checks,
   invokes the audit, consumes the report, or owns its retention.
2. Exposing a generic endpoint would turn an internal helper into public
   behavior without an authorization, trust, or persistence contract.
3. An autonomous scanner is a different responsibility and is not implied by
   the existing audit helper.
4. Receipt emission would require a separate decision about the event,
   mutation, workspace, and canonical receipt boundaries.
5. Patch generation or pull-request creation would cross the current
   audit-only and no-write boundary.
6. The smallest correct implementation is the current tested library surface
   until a concrete caller workflow exists.

## Required future trigger

Open a production-reachability chain only when an accepted workflow names:

- the explicit caller;
- the supplied input and repository boundary;
- the report consumer;
- the authorization and workspace context;
- persistence and retention requirements;
- error and timeout semantics;
- whether the operation is local-only or remotely exposed.

The first future entry point must remain caller-supplied and audit-only. An
autonomous scanner, proposal generator, patch writer, or PR creator requires a
separate later gate.

## Minimum future proof

If a caller-supplied audit entry point is authorized later, targeted tests must
prove:

1. only bounded caller-supplied checks reach `runSelfHealerAudit()`;
2. repository paths cannot escape the authorized root;
3. unsupported modes fail closed before any side effect;
4. report output matches the existing library contract;
5. errors do not create memory, filesystem, branch, patch, or PR writes;
6. the new entry point does not claim autonomous discovery;
7. CLI, HTTP, or MCP envelopes remain compatible with their existing contracts;
8. no receipt is emitted unless a separate receipt contract authorizes it.

## Allowed follow-up

After exact-head review, merge, and closeout of this docs-only decision, the
next smallest Self-Healer task may be a docs-only README wording reconciliation.
No runtime gate is automatically authorized.

## Non-claims

This decision does not claim:

- production Self-Healer reachability;
- autonomous repository, test, or Git scanning;
- runtime finding discovery;
- Memory, Audit, or receipt integration;
- proposal, patch, branch, or pull-request creation;
- auto-fix or auto-merge;
- Self-Healer product readiness;
- V4, Rust, V5, or ecosystem completion.
