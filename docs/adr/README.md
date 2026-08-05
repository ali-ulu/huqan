# Architecture Decision Records

All ADRs live in this directory. There are two numbering tracks, kept
separate intentionally rather than merged into one sequence:

- **`ADR-0NN-*.md`** — main product/runtime decisions (trust kernel, memory
  core, approval runtime, self-healer loop, etc.).
- **`ADR-V1-0NN-*.md`** — decisions scoped to the V1 causal/granite engine
  track (`docs/v1-causal-granite-requirements.md`).

The two tracks use independent numbering because they document different
subsystems' decision history; renumbering them into one sequence would not
add information and would break existing cross-references for no benefit.

Old root-level `docs/ADR-0NN-*.md` paths now contain a redirect stub
pointing here; update any new links to use `docs/adr/ADR-0NN-*.md` directly.

`ADR-006-self-healer-loop.md` is superseded by `ADR-007-self-healer-loop.md`
(status stated in both documents).
