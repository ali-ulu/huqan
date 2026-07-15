# ADR-007 - Self-Healer Loop

## Status

Accepted as documentation authority

Implementation status: Partial

## Authority

This ADR is the canonical Self-Healer architecture authority.

Current implemented authority remains in source and tests:

- `lib/self-healer/finding-schema.js`
- `lib/self-healer/audit-runner.js`
- `lib/self-healer/finding-classifier.js`
- `lib/self-healer/index.js`
- `test/self-healer-*.test.js`

The current implemented surface is limited to finding schema validation,
caller-provided check normalization into audit reports, and finding
classification. Nightly repo audits, autonomous repo scanning, fix proposal
generation, draft patch/PR production, receipt emission, and memory/audit
integration are target capabilities unless a later source file and test prove
otherwise.

## Context

HUQAN / AXIOM now:

- can judge claims
- can gate agent/tool actions
- has an approval workflow
- has a deterministic Memory Core
- has passed security hardening

On top of that foundation, the next technical phase is the Self-Healer Loop.

## Problem

The codebase keeps accumulating bugs, security regressions, drift, flaky tests, and stale docs. Today these are found through manual scan/review. HUQAN needs a safe, local-first feedback loop that can observe its own repo and agent actions in a controlled way.

## Decision

v0.9.2 Self-Healer Loop is not an automatic fix engine. It is a human-reviewed,
proposal-based repo audit loop. Receipt production is a required target
invariant, not a current runtime capability.

As target architecture, Self-Healer can eventually:

- run nightly repo audits (planned)
- find bugs (planned beyond caller-provided checks)
- find security smells (planned beyond caller-provided checks)
- find stale docs (planned beyond caller-provided checks)
- find flaky tests (planned beyond caller-provided checks)
- classify risk (implemented for supplied findings)
- suggest fixes (planned)
- suggest tests (planned)
- propose draft PRs (planned)
- produce Trust Receipts (planned)
- generate candidate Memory Core audit/event records (planned)

Self-Healer cannot:

- auto-merge
- write canonical memory without review
- deploy to production
- read secrets
- run destructive commands
- do broad refactors
- apply fixes without human approval
- silently close security findings

## Core Loop

Current runtime implements only the audit-only helper portion of this loop: it
accepts caller-provided checks, normalizes them into validated findings, and
returns a report. It does not scan the repository autonomously, run tests,
inspect Git history, create branches, write memory, emit receipts, or open PRs.

1. Observe

   - repo state
   - tests
   - recent commits
   - open PRs
   - security reports
   - docs drift
   - memory/audit history

2. Detect

   - bug candidate
   - flaky test candidate
   - security regression candidate
   - stale documentation
   - missing test
   - unsafe pattern

3. Classify

   - severity
   - confidence
   - affected files
   - runtime/security/doc scope
   - whether human approval is required

4. Propose

   - fix plan
   - test plan
   - risk explanation
   - rollback note
   - expected diff scope

5. Gate

   - allow
   - review
   - dry_run_only
   - block

6. Draft

   - optional branch
   - optional patch
   - optional PR draft
   - no merge

7. Receipt

   - Trust Receipt for finding
   - Trust Receipt for proposed fix
   - Trust Receipt for reviewer decision

8. Remember

   - write candidate memory/event only after approval
   - no canonical memory mutation without review

## Required Invariants

- Finding != fact until validated.
- Suggestion != fix until tests pass.
- Draft PR != approved change.
- Memory candidate != canonical memory.
- Self-Healer cannot approve itself.
- Auto-merge is forbidden.
- Human review is mandatory for code, security, and runtime changes.
- Every Self-Healer action must eventually produce an auditable receipt. This
  is a required target invariant; current runtime only carries nullable
  `receiptId` fields and does not implement a receipt emitter.
- Determinism currently means deterministic canonical IDs and normalization,
  not bit-for-bit identical full report objects. Timestamp fields such as
  `finding.createdAt`, `finding.updatedAt`, and `auditReport.createdAt` may
  default to current time.

## Vocabulary Namespaces

The following namespaces are distinct and must not be treated as aliases:

- HUQAN runtime gate verdict: `allow`, `review`, `dry_run_only`, `block`
- Self-Healer workflow mode: `audit_only`, `proposal_only`, `draft_patch`,
  `draft_pr`, `blocked`
- Finding disposition / recommended action: `observe`, `propose`,
  `require_review`, `block`, `quarantine`

## Integration Points

- Trust Kernel
- Action Gate
- Approval Runtime
- Memory Core
- Audit Log
- Trust Receipt
- Security hardening reports
- GitHub PR workflow
- future Repo Scanner

## Safety Model

Self-Healer runs in constrained modes:

- `audit_only` (IMPLEMENTED)
  - accept caller-provided checks
  - produce validated findings and an audit report
  - does not read or scan repository contents autonomously
  - no write

- `proposal_only` (PLANNED)
  - produce fix/test plan
  - no patch

- `draft_patch` (PLANNED)
  - create branch/patch
  - no merge

- `draft_pr` (PLANNED)
  - open PR
  - no merge

- `blocked` (PLANNED AS EXPLICIT REPORT STATE)
  - stop and emit receipt

## v0.9.2 Non-Goals

- no full autonomous coding agent
- no auto-merge
- no production deployment
- no public GitHub App
- no V4 workbench
- no V5 shared trust layer
- no model training
- no cloud dependency
- no secret scanning product claim
- no "self-fixing software" overclaim

## Acceptance Criteria

v0.9.2 PR0 was a docs-only architecture gate. Current source-of-truth
reconciliation is complete when:

- ADR exists
- roadmap exists
- safety invariants are explicit
- PR sequence is defined
- non-goals are explicit
- current partial runtime implementation is labelled accurately
- planned capabilities are not presented as implemented
- no package files changed
- docs-only PR opened
- merge not performed
