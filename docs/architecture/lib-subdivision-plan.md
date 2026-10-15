# `lib/` subdivision plan

Status: assessment. This document proposes a strategy; it does not change the
layout. No gate enforces it, and nothing here is a commitment to move code.

## Why this exists

`lib/` is a flat directory: 775 `.js` files sit directly in `lib/`, and 27
subdirectories hold another 412. Finding E raised the question of whether the
flat root is a defect. This document answers that with the measured cost of the
alternatives, so the next person does not re-derive it.

## The flat root is a scale choice, not a defect

The root is not a dumping ground; it is a namespace. Files are named by prefix
so a reader can group them without a directory:

| Prefix | Files in `lib/` root |
|---|---|
| `memory-` | 60 |
| `graph-` | 50 |
| `external-action` | 42 |
| `cognitive-` | 38 |
| `external-client` | 33 |
| `workflow-` | 16 |
| `agent-v3` | 12 |
| `semantic-model` | 9 |
| `kernel-v2` | 7 |

Two flat files that share a basename in different directories would be two
module instances to Node, so a caller could hold a "different" copy of the same
module. The flat root cannot have that accident by construction. A subdivision
can, and that is the first thing to design around.

## Why a big-bang move is the wrong move

Every `lib/*.js` file is required by relative path (`require('./foo')`). Moving
one file means editing every importer's path, and the web is dense:

- 1,610 intra-root relative `require('./x')` edges.
- 621 of the 775 root files are imported by relative path at least once.

Beyond the importers, a move touches artifacts that are keyed on the path:

- `scripts/architecture-tracker-baseline.json` (5,213 `lib/` references).
- `config/coverage-baseline.json` (893 `lib/` references).
- `config/reachability-baseline.json` (measured counts).
- `scripts/architecture-dependency-graph.js` assignment rules: a module that
  matches no rule is **unassigned**, and the gate fails on it. A new
  `lib/<dir>/` must be added to a rule before the first file moves into it.
- Living-document citations: `scripts/check-docs-drift.js` fails a document
  that cites a path no longer on disk.

A single move is small; a sweep is not. A sweep also cannot be reviewed as a
refactor, because every baseline it rewrites is a number a reviewer would have
to re-verify by hand.

## The version-suffixed files are coexistence, not the root problem

The root carries `-v2` / `-v3` modules next to their predecessors:

- `agent-v3-*` (12), `kernel-v2-*` (7), `semantic-model-artifact-v2`.
- 22 root files carry a `-v[0-9]` suffix; 14 are imported by literal path, 8
  are not referenced by a literal require (candidates for removal, not moves).

The Kernel and KernelV2 substitutability contract is documented in
`docs/architecture-policy.md` and `docs/adr/ADR-013-kernel-v2-substitutability.md`.
The coexistence is a deliberate, tested contract, so a directory named `v3/`
would obscure it rather than clarify it. Retirement of a superseded module is a
separate decision with its own evidence; it is not part of a layout change.

## Staged strategy

If the root is ever subdivided, do it one leaf at a time, never as a sweep.

1. **Move on touch.** When a file is edited for another reason, move it into
   the directory that already fits (for example an existing `lib/memory/`).
   The move rides in that PR; no PR exists only to move.
2. **Leaves first.** Start with files that have the fewest relative importers.
   A file with one importer is a one-line change; a file with fifty is not.
3. **Group only in bulk.** Create a new directory only when at least eight
   files move into it together. A directory with two files is a namespace with
   no reader benefit.
4. **Never split a basename pair.** If a candidate has a same-basename twin
   anywhere in `lib/`, move both or neither, so Node still resolves one module
   instance.
5. **Register before moving.** Add the new directory to
   `scripts/architecture-dependency-graph.js` in the same PR as the first file
   that lands in it, or the gate reports an unassigned module.

## Per-move checklist

Each move is one small PR that carries, in the same commit series:

- the file move and every importer path edit;
- `node scripts/architecture-snapshot.js --write` if the graph artifact moved;
- `config/reachability-baseline.json` and `config/coverage-baseline.json` if
  their measured keys moved;
- `npm run check:docs-drift` green for any document that cites the old path;
- the full test suite green.

## Where not to subdivide

Do not invent a directory for the domain ring. The flat `lib/*.js` modules are
assigned to the Core ring by the dependency graph; a new directory that the
graph does not know is unassigned, and the gate fails. Subdivision is only
worth it where an existing directory already expresses the grouping, or where a
cluster is large enough to earn a new one and is registered with the graph.

## Recommendation

Keep the flat root as the default. Apply the move-on-touch rule to the largest
prefix clusters, starting with the leaves, and treat a superseded version
module as a retirement candidate rather than a move. Do not schedule a
big-bang reorganization: its review cost is unbounded and its correctness
hazard (duplicate basenames) is real.
