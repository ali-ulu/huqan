# HUQAN Judge Engine Architecture

## Purpose

HUQAN’s judge engine is the deterministic decision layer that sits above storage.
It is responsible for turning evidence, provenance, admission rules, and read-only
inspection results into auditable verdicts.

This document describes the current architecture as it exists now. It does not
claim a final single-module implementation, and it does not introduce new runtime
behavior.

## Storage vs Judge

The storage layer is where state lives:

- SQL / SQLite / memory database
- receipts
- provenance records
- audit history
- workspace-scoped evidence

The judge engine is not the database.
The judge engine is the deterministic authority that evaluates evidence from the
storage layer and decides what may happen next.

In other words:

- storage preserves facts
- the judge reconciles facts into a verdict

## Current Judge Components

HUQAN does not yet have a single `brain.js` final module.
Instead, the judge engine currently exists as a distributed set of deterministic
components that each own a narrow responsibility:

- **Action Risk Classifier**: classifies risk from action shape, target, and context
- **Tool Call Gate**: classifies and blocks or reviews tool calls before execution
- **Memory Admission Gate**: decides whether a memory write may be admitted
- **Context Integrity Surface**: reports whether context evidence is intact and
  read-only
- **Verdict Reconciliation**: normalizes domain-specific decisions into the shared
  verdict vocabulary
- **Trust Receipt Engine**: records the evidence trail and receipt chain for a
  decision
- **Provenance / Audit Primitives**: preserve what was known, who acted, and why
- **WB1 / WB2 read-only inspectors**: expose inspection-only views of receipts and
  memory/context evidence without mutation

These components are already enough to form a distributed deterministic judgment
layer. BRAIN-0 documents that architecture before any consolidation or refactor.

## Decision Authority

Decision authority belongs to deterministic judge logic.

Model output may advise, classify, or propose.
Model output may not directly authorize:

- destructive action
- network mutation
- memory admission
- production writes

Only deterministic judge logic may produce the final action verdict.

## Verdict Model

The shared verdict vocabulary is intentionally small:

- `allow`
- `review`
- `dry_run_only`
- `block`

That vocabulary is the authoritative control surface for the judge engine.
Any model-specific or UI-friendly wording must remain presentation-only and may not
override the canonical verdict.

## What Exists Now

The current repository already contains the working pieces of this distributed
judge layer:

- deterministic gates for risky tool and memory actions
- admission-aware learning and approval flows
- trust receipts and receipt chaining
- read-only receipt inspectors
- read-only memory/context inspectors
- audit/provenance records

This means HUQAN already has a distributed deterministic judgment layer that can be
inspected, hardened, and later consolidated.

## What Does Not Exist Yet

This note does not claim:

- a fully consolidated `brain.js`
- a production-ready control plane
- a truth guarantee
- hallucination elimination
- mandatory inline gating for every connector
- V5 readiness

Those are larger product and roadmap questions. They are not part of BRAIN-0.

## Safe Claim

The safe and accurate claim is:

> HUQAN has a distributed deterministic judgment layer that reconciles risk,
> provenance, memory admission, tool-call policy, context integrity, and Trust
> Receipt evidence into an auditable verdict.

That is the architecture this note records.

## Non-Claims

This note does not claim:

- fully autonomous agent behavior
- production enterprise control plane readiness
- truth guarantee
- hallucination elimination
- all connectors are already mandatory inline-gated
- V5 readiness
- new runtime behavior

## Summary

BRAIN-0 exists to make the judge architecture explicit:

- storage is not the judge
- model output is advisory
- deterministic verdict logic is final
- receipts and audits preserve the decision trail
- the current judge is distributed, not yet consolidated

That separation is the point of the architecture note.
