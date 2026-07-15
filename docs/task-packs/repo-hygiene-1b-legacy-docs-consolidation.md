# REPO-HYGIENE-1B Legacy Documentation Consolidation

## Purpose

Define the exact, docs-only move contract for consolidating six high-confidence
legacy artifacts into `docs/archive/`. This task-pack does not move, delete,
rewrite, or otherwise modify any legacy document.

## Canonical Base

- Repository: `huqan-com/huqan`
- Required branch: `main`
- Scope-definition base: `d9b7bb7adad519e21de53f4640fa111d417503fe`
- Previous checkpoint: `REPO-HYGIENE-1_LEGACY_DOCS_AUDIT_GREEN`
- Authorized successor: `REPO-HYGIENE-1B_LEGACY_DOCS_CONSOLIDATION`

The scope-definition base records the source state against which this task-pack
was authored. It is not the future implementation base.

The 1B implementation may begin only from the exact post-merge canonical
`main` SHA supplied in a separate implementation authorization after this
task-pack has been merged. Before implementation, the checked-out branch must
be `main`, `HEAD` must equal `origin/main`, `HEAD` must equal that separately
authorized 1B implementation base, and this task-pack must exist unchanged at
that base. Otherwise stop with `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH`.

## Approved Move Set

The implementation gate may make only these byte-preserving moves:

| Source | Destination |
| --- | --- |
| `PUBLIC_RELEASE_POST.md` | `docs/archive/releases/PUBLIC_RELEASE_POST.md` |
| `RELEASE_NOTES_v0.4.0.md` | `docs/archive/releases/RELEASE_NOTES_v0.4.0.md` |
| `RELEASE_NOTES_v2.0.0.md` | `docs/archive/releases/RELEASE_NOTES_v2.0.0.md` |
| `RELEASE_V2.md` | `docs/archive/releases/RELEASE_V2.md` |
| `docs/demo-script-v1.md` | `docs/archive/demos/demo-script-v1.md` |
| `.kiro/specs/llm-memory-layer/.config.kiro` | `docs/archive/tooling/kiro/llm-memory-layer/config.kiro` |

The six approved legacy artifacts must be moved byte-for-byte.

The only permitted non-move content change is a minimal update to the existing
tracked file `docs/archive/README.md` so that it satisfies the Archive Index
Contract. The existing archive index must not be deleted or recreated as an
unrelated new document. Accurate existing historical context should be
preserved where compatible with the contract.

## Archive Index Contract

`docs/archive/README.md` must state all of the following:

- Archived documents are not the current-main source of truth.
- Version numbers, SHAs, and test counts inside archived documents are historical
  context.
- Archived content is not a runtime, build, workflow, or test input.
- The current demo document is `docs/v4/v4-demo-script.md`.
- Canonical current state is defined by `main` and active roadmap documents.
- Historical release documents must be interpreted together with their Git tags.

`docs/archive/README.md` is an existing tracked file and is intentionally
modified in the 1B implementation. It is not part of the byte-preserving hash
set applied to the six moved legacy artifacts.

## Explicit Exclusions

The following paths are outside the 1B implementation gate:

| Path | Reason |
| --- | --- |
| `docs/ADR-006-self-healer-loop.md` | Source-of-truth and supersession decision is unresolved. |
| `docs/ADR-007-self-healer-loop.md` | Source-of-truth and supersession decision is unresolved. |
| `docs/self-healer-roadmap.md` | Requires a separate current-code and ADR reconciliation audit. |
| `.kiro/specs/llm-memory-layer/requirements.md` | Architectural and specification value is unresolved. |
| `docs/v4/v4-demo-script.md` | Active canonical demo document. |
| `docs/v4/big-file-refactor-gate.md` | Historical technical evidence. |
| `docs/launch-uat.md` | Old URLs require the separate `GITHUB-MIGRATION-3A` gate. |

## Historical Integrity Rules

- Do not delete historical release evidence.
- Do not rewrite historical test counts, release claims, versions, or SHAs.
- Do not change Git tags.
- Preserve each moved file byte-for-byte, including the `.config.kiro` to
  `config.kiro` rename.
- Before and after each move, compare SHA-256 hashes. On Windows, use
  `Get-FileHash -Algorithm SHA256`.
- SHA-256 equality is mandatory for the six approved source-to-destination
  moves. `docs/archive/README.md` is intentionally updated and is excluded from
  the pre/post move hash-equality requirement.
- Do not unnecessarily rewrite the existing archive index. Limit its update to
  the content required by the Archive Index Contract.
- Historical repository URLs are not replaced in this gate. Record that work as
  `DEFER_TO_GITHUB-MIGRATION-3A`.

## Reference Safety Checks

Before and after the implementation, run:

```bash
git grep -n 'PUBLIC_RELEASE_POST.md' -- . || true
git grep -n 'RELEASE_NOTES_v0.4.0.md' -- . || true
git grep -n 'RELEASE_NOTES_v2.0.0.md' -- . || true
git grep -n 'RELEASE_V2.md' -- . || true
git grep -n 'docs/demo-script-v1.md' -- . || true
git grep -n '\\.config\\.kiro' -- . || true
```

If an active build, runtime, workflow, or test reference is found, stop with
`BLOCKED_BY_ACTIVE_DOCUMENT_DEPENDENCY`.

## Expected Diff

The future implementation diff is limited to six renames and one minimal update
to the existing archive index:

```text
R  PUBLIC_RELEASE_POST.md
   docs/archive/releases/PUBLIC_RELEASE_POST.md
R  RELEASE_NOTES_v0.4.0.md
   docs/archive/releases/RELEASE_NOTES_v0.4.0.md
R  RELEASE_NOTES_v2.0.0.md
   docs/archive/releases/RELEASE_NOTES_v2.0.0.md
R  RELEASE_V2.md
   docs/archive/releases/RELEASE_V2.md
R  docs/demo-script-v1.md
   docs/archive/demos/demo-script-v1.md
R  .kiro/specs/llm-memory-layer/.config.kiro
   docs/archive/tooling/kiro/llm-memory-layer/config.kiro
M  docs/archive/README.md
```

Any additional changed file is `BLOCKED_BY_SCOPE_DRIFT`.

## Validation

The implementation gate must run:

```bash
git diff --summary
git diff --name-status
git diff --check
git status --short
```

Full-suite execution is optional for a byte-preserving docs-only move. If it is
run, the reference baseline is `1936 total / 1907 pass / 0 fail / 29 skipped`.

## Blockers

- `BLOCKED_BY_CANONICAL_SOURCE_MISMATCH`
- `BLOCKED_BY_SCOPE_DRIFT`
- `BLOCKED_BY_ACTIVE_DOCUMENT_DEPENDENCY`
- `BLOCKED_BY_HISTORICAL_EVIDENCE_AMBIGUITY`

## Non-Claims

This task-pack does not authorize:

- changes to README files other than the minimal
  `docs/archive/README.md` update;
- changes to `docs/launch-uat.md` or repository URLs;
- ADR-006/007 resolution or `.kiro` requirements disposition;
- runtime, test, fixture, schema, package, or V5 changes;
- branch/tag cleanup or repository settings changes;
- `REPO-HYGIENE-2`, refactoring, or a GitHub migration gate.

## Hard Stop

Even after this task-pack is merged, do not begin 1B automatically. Do not move
or delete legacy files, alter excluded documents, or open a subsequent hygiene
gate without a separate authorization.

## Required Final Report

The future implementation report must include:

```text
PLAN CHECK:
1. Previous checkpoint:
2. Repository:
3. Canonical base:
4. Branch:
5. Changed files:
6. Next gate:

BASE REALITY:
TASK-PACK PATH:
APPROVED MOVE SET:
EXPLICIT EXCLUSIONS:
HISTORICAL INTEGRITY RULES:
EXPECTED IMPLEMENTATION DIFF:
DIFF CHECK:
WORKTREE:
COMMIT:
PUSH:
PR:

BLOCKING FINDINGS:
NON-BLOCKING FINDINGS:
FINAL VERDICT:
```
