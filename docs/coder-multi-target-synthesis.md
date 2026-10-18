# Multi-target synthesis

Status: implemented in the Coder synthesis path; bounded independent string and numeric
repairs, not general repository synthesis or a learning-gain claim.

`huqan coder request.json --synthesize --authorize --root <repository> --json`
can synthesize two through eight distinct JavaScript/CommonJS targets and test
them together. The request uses `operation: { "type": "sequence" }`, declares
every target in `allowedPaths`, and supplies an independent `test.command`.

```json
{
  "id": "repair-two-functions",
  "level": "l0",
  "allowedPaths": ["a.js", "b.js"],
  "operation": { "type": "sequence" },
  "test": { "command": "node acceptance.js" },
  "synthesis": {
    "family": "multi-target",
    "targets": [
      { "path": "a.js", "family": "affine-integer", "examples": [
        { "input": 0, "expected": -2 },
        { "input": 1, "expected": 1 },
        { "input": 3, "expected": 7 }
      ] },
      { "path": "b.js", "family": "affine-integer", "examples": [
        { "input": 0, "expected": 5 },
        { "input": 1, "expected": 7 },
        { "input": 3, "expected": 11 }
      ] }
    ]
  }
}
```

Each target reuses the existing `affine-integer`, `arithmetic-expression`, or
`array-fold`, or `string-expression` synthesis grammar and validation. Named functions can declare
`functionName` as in single-target synthesis. Paths must be distinct and pass
the existing root containment and ordinary mutation gate. This mode accepts
no supplied replacement text or sequence steps.

By default (or with `synthesis.searchMode: "strict"`), all retained target
candidates are combined into sequence proposals. A child
search with omitted matching candidates, or a product exceeding the existing
eight-candidate loop cap, is refused with `SYNTHESIS_MULTI_TARGET_OVER_CAP`;
there is no silent Cartesian truncation. A failed test rolls back the whole
sequence before the next proposal. Training inputs do not substitute for the
independent declared test.

Explicit `synthesis.searchMode: "bounded"` permits up to eight joint proposals
when child searches omit matches or the product exceeds eight. Each child still
runs its full grammar search (string search enumerates 1885 programs); this flag
bounds joint attempts, not child enumeration. Joint proposals follow increasing
candidate-index sum, then lexicographic index order. Only a bounded frontier is
allocated, never the full Cartesian space. Unicode case chains remain distinct
programs; no equivalence-based candidate merging occurs.

The bounded plan reports per-target omission, `totalCandidateCombinations`
(including omitted child matches), `retainedCandidateCombinations`,
`omittedCandidateCombinations`, and `searchComplete`. Counts exceeding the safe
integer range are exact decimal strings. For example 14 string matches (8
retained, 6 omitted) and 3 numeric matches report 42 total combinations, 8
retained and 34 omitted, with `searchComplete: false`. A smaller explicit run
budget further reduces retained proposals and increases reported omissions.
Tests and held-out results never select the joint proposals. Ordinary authority,
eight shared attempts, and whole-sequence rollback remain in force.

With a journal, mixed string/numeric sequences can also be remembered and
reused under different project paths, function names and parameter names.
Every step reuses the existing closed AST adapter; the sealed method's operators,
constants and string stages remain fixed. The original candidate bytes and
schema version stay unchanged. Adapted methods are transient derivatives whose
parent hash and evidence refer to the sealed source procedure.

The selection stage proposes an adaptation; the runtime independently derives it
again from the actual target files after checking the source seal and sequence
hash. Qualification fixtures retain their source paths and names. Their paths
are mapped to the targets and each file receives only its own identifier and
function-anchor binding. Property method names remain unchanged. A forged
proposal, source record or qualification binding supplies no authority.

With a journal, `synthesis.rememberFile` explicitly stores a kept successful
sequence as a source-bound `replacement_sequence` candidate. Unauthorized,
failed or dry-run attempts never create a record. Declare qualification maps
as described in [replacement sequence memory](coder-replacement-sequence-memory.md).

`synthesis.reuseMemory: true` checks the validated joint source method against
each target's own training examples before the ordinary routing, qualification,
trust and mutation gates run. Target paths bind positionally to the stored
steps while preserving their operators, constants, string stages and order;
function and parameter names bind to each target. Successful reuse reports zero fresh enumeration and does not create a
duplicate record, even if `rememberFile` names a different output. This is not
a total-cost or speedup measurement. If no valid applicable method exists,
fresh synthesis may run; corrupt source/artifact errors stop immediately.
A reused method failing independent acceptance may start fresh synthesis only
after rollback is verified. Its attempt is charged against the same bounded
candidate budget; budget one stops with `SYNTHESIS_BUDGET_EXHAUSTED`. The failed
joint method is excluded by every target's canonical AST, so cosmetic source
formatting cannot cause it to be retried. Gate, source, readback and unverified
rollback failures never trigger this fallback. A later successful proposal can
be remembered from its own sealed search run without editing the older record.

The mode does not infer dependencies between targets,
support arbitrary source grammars, or generate requirements from natural text.

Focused checks: `node --test test/coder-multi-target-synthesis.test.js
test/coder-multi-target-learning.test.js test/coder-arithmetic-synthesis.test.js
test/coder-mixed-target-synthesis.test.js test/coder-mixed-target-learning.test.js`.
Native coverage includes an
unauthorized attempt, two successful synthesized files, and independent
acceptance failure restoring both files. Pure coverage includes unchanged
source files, invalid/duplicate paths, unsupported record options and a real
array-fold search whose omitted matches would otherwise hide an over-budget
Cartesian set.

The retry fixture uses a source method `(x - 3) % 3` and a target requiring
`x % 3`: both fit the negative training examples, but the positive held-out
input distinguishes them. With budget one, the failed memory attempt restores
both files and stops; with budget two, the first different fresh proposal
passes and is sealed as a new method. This is a bounded counterexample, not
evidence of general learning gain.
