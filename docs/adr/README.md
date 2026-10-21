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

`ADR-015-signed-policy-and-transparency-log.md` records the signed-policy
object, the transparency-log requirement and the trust/deployment boundary
taken in #3490 (PR #3604).

`ADR-020-posix-authority-parity.md` records the Linux and macOS approval-authority
layout, hardening and threat model (#4082). It takes number 020 because ADR-019 was
already used by the control-room operator grant.

`ADR-021-container-support-model.md` records the model for how a container reaches
the approval authority (#4171, #4082 open question 7): the service stays on the
host, a container replaces the Layer B agent user and reaches the service only
through the signed HTTP channel. It is a model only, with no date, and it records
that the `container_unverified` probe the install documentation used to promise
was never implemented.
