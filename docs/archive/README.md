# AXIOM — Archive Index

This directory contains **historical reports, snapshots, and draft templates**
that were preserved from earlier AXIOM versions and review cycles.

These files are **not canonical specifications**. They are kept for traceability
of decisions made during past reviews, sandbox experiments, and strategy
discussions. Do not treat any document here as the current source of truth.

## Canonical Process Documentation

Current canonical documents live in `docs/` at the repository root:

- `docs/SECURITY-GATE.md` — security and gating procedure.
- `docs/PR_CHECKLIST.md` — PR flow and checklist.
- `docs/AXIOM-v0.9.1-General-Review-Raporu.md` — canonical v0.9.1 review.
- `docs/memory-core-v0.9.1.md` — Memory Core specification.

For architecture decisions, also see the `docs/ADR-*.md` files.

## Subdirectories

- `archive/v0.8-review/` — AXIOM v0.8 review artifacts (blocker triage, master
  bug report, technical analysis, root review report). Most issues documented
  here were resolved by the v0.9.1 line. Kept as historical evidence of the
  bug surface and the decisions taken.
- `archive/sandbox-v0.8/` — Sandbox runner smoke test report from the v0.8
  cycle (35 PASS / 4 FAIL). Current sandbox behavior is covered by the test
  suite in `test/`.
- `archive/self-analyze-v0.8/` — One-shot kernel self-analysis snapshot from
  the v0.8 cycle. Not deterministic; do not use for runtime decisions.
- `archive/strategy-2026/` — Strategic paths document considered for the
  v0.9.1 → v1.0 transition. The decision date has passed and the strategy
  itself is being re-evaluated for the v1.0 forward-compatibility phase. Kept
  as historical context only.

## Templates

- `docs/templates/auto-pr-receipt.md` — Trust Receipt template originally
  drafted for an `auto-pr.js` infrastructure. Reserved for the future
  Self-Healer / Trust Receipt workstream and not consumed by any current
  runtime path.

## Update Policy

- New historical artifacts should land in a dated subdirectory
  (e.g. `archive/v0.9.1-review/`).
- Do not delete files from this directory without a release-tagged cleanup PR.
- Do not modify archived files; if corrections are needed, add a note in the
  relevant canonical document and cross-link.
