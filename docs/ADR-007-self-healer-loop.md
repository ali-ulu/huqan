# ADR-007 - Self-Healer Loop

## Status

Proposed

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

v0.9.2 Self-Healer Loop is not an automatic fix engine. It is a human-reviewed, receipt-producing, proposal-based repo audit loop.

Self-Healer can:

- run nightly repo audits
- find bugs
- find security smells
- find stale docs
- find flaky tests
- classify risk
- suggest fixes
- suggest tests
- propose draft PRs
- produce Trust Receipts
- generate candidate Memory Core audit/event records

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
- Every Self-Healer action must produce an auditable receipt.

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

- `audit_only`
  - read repo
  - produce findings
  - no write

- `proposal_only`
  - produce fix/test plan
  - no patch

- `draft_patch`
  - create branch/patch
  - no merge

- `draft_pr`
  - open PR
  - no merge

- `blocked`
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

v0.9.2 PR0 is complete when:

- ADR exists
- roadmap exists
- safety invariants are explicit
- PR sequence is defined
- non-goals are explicit
- no runtime code changed
- no package files changed
- docs-only PR opened
- merge not performed
