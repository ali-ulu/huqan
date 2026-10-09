# AXIOM — Archive Index

This directory contains **historical reports, snapshots, and draft templates**
that were preserved from earlier AXIOM versions and review cycles.

These files are **not canonical specifications**. They are kept for traceability
of decisions made during past reviews, sandbox experiments, and strategy
discussions. Do not treat any document here as the current source of truth.

## Archive Contract

- Archived documents are not the current-main source of truth.
- Version numbers, SHAs, and test counts inside archived documents are
  historical context.
- Archived content is not a runtime, build, workflow, or test input.
- The current demo document is `docs/v4/v4-demo-script.md`.
- Canonical current state is defined by `main` and active roadmap documents.
- Historical release documents must be interpreted together with their Git tags.

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
- `archive/self-analyze-v0.8/` — One-shot kernel self-analysis snapshot from
  the v0.8 cycle. Not deterministic; do not use for runtime decisions.
- `archive/strategy-2026/` — Strategic paths document considered for the
  v0.9.1 → v1.0 transition. The decision date has passed and the strategy
  itself is being re-evaluated for the v1.0 forward-compatibility phase. Kept
  as historical context only.

## Tarihsel sürüm doğrulama planları

2026-10-09 tarihinde arşivlenen aşağıdaki belgeler güncel sürüm doğrulama
prosedürü değildir. Eski içerikleri, arşiv notu dışında korunmuştur:

- [v0.8 RC smoke](release-smoke-2026-10-09/v0.8-rc-smoke.md): v0.8.0'a özgü
  sürüm ve test beklentileri içerir; atıf yaptığı paket formatı testi artık yoktur.
- [V3 Core smoke checklist](release-smoke-2026-10-09/v3-smoke-checklist.md):
  V3 kapsamını ve o dönemdeki MCP kurulum durumunu kaydeder.
- [Memory Core smoke](release-smoke-2026-10-09/memory-core-smoke.md):
  v0.9.1 doğrulama planını ve tarihsel 682+ senaryo beklentisini kaydeder.

Güncel yerel kurulum ve test adımları için [CONTRIBUTING.md](../../CONTRIBUTING.md)
belgesine bakın.

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
