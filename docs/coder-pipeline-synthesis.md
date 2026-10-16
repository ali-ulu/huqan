# Joint pipeline synthesis

The Coder synthesis entry supports a declared two-stage numeric pipeline:
`second(first(input))`. It learns both stage expressions from joint examples;
no intermediate outputs, replacement source or per-stage examples are supplied.
Stage order is explicit: this does not infer a repository dependency graph.

```json
{
  "id": "joint-fourth-power",
  "level": "l0",
  "allowedPaths": ["a.js", "b.js"],
  "operation": { "type": "sequence" },
  "test": { "command": "node acceptance.js" },
  "synthesis": {
    "family": "pipeline",
    "targets": [{ "path": "a.js" }, { "path": "b.js" }],
    "examples": [
      { "input": -3, "expected": 81 },
      { "input": -1, "expected": 1 },
      { "input": 0, "expected": 0 },
      { "input": 2, "expected": 16 },
      { "input": 4, "expected": 256 }
    ]
  }
}
```

Run with `huqan coder request.json --synthesize --authorize --root <repository> --json`.
Targets must already contain supported single-argument arithmetic functions in
distinct JavaScript/CommonJS files. A target may name a `functionName`. The
runtime does not insert imports or rewrite callers: the declared independent
test must exercise the real composition and reject incorrect wiring.

Both stages reuse the existing grammar: parameter, constants 0 through 3,
operators `+`, `-`, `*`, `%`, and at most two operations per stage. Search
evaluates only the closed AST, never target JavaScript. Intermediate and final
observations must be safe integers. There are three through 32 distinct numeric
training inputs; input and expected magnitudes are at most one million.

The stage enumeration budget is 4105 attempts each, and the pair budget is
16,851,025 (`pairBudget`). `stageEnumerated` reports each stage's enumeration
attempts and `evaluatedPairs` reports joint comparisons; `enumerated` sums both
phases. `searchBudget` is their combined upper bound, 16,859,235. These counters
exclude parsing, validation, the independent acceptance test and rollback; they
are not CPU or wall-clock cost measurements. Matching pairs are ranked by total operation count then lexical
operation data. At most eight pairs are retained; the result reports actual
pair evaluations, matching pairs, stage pool sizes and omitted candidates.
This is a bounded incomplete search when matches are omitted. It does not claim
a unique internal decomposition from joint outputs. Both target replacements
must change their source; a baseline already satisfying the composition stops.

Training success is only a proposal. The existing ordinary mutation gate,
explicit authorization, independent declared test, candidate budget and verified
whole-sequence rollback remain required. Fresh-process native tests cover
unauthorized refusal, held-out composition inputs, and restoration of both files
after failed acceptance.

With a journal, `synthesis.rememberFile` opts into the existing source-sealed
`replacement_sequence` candidate memory. Only a kept, independently tested pair
is remembered. Unauthorized, failed and dry-run requests never create a record.
Supply at least two negative qualification maps in `qualificationPaths` as in
[replacement sequence memory](coder-replacement-sequence-memory.md).

`synthesis.reuseMemory: true` rebuilds each stored candidate from its sealed
source, binds the declared target paths and parses both proposed outputs through
the existing closed arithmetic AST reader. Joint training examples must match
the composition, rather than either intermediate function separately. Reuse
reports zero fresh enumeration; source validation, qualification, trust replay,
the ordinary write gate and independent acceptance still run. This is not a
total-cost or speedup measurement. Successful reuse does not duplicate or edit
the source candidate, even when `rememberFile` names a different destination.

No applicable valid method permits fresh search. Corrupt source/artifact errors
stop without searching. A memory method failing independent acceptance permits
fresh search only after verified rollback, charging its attempt against the
same candidate budget. Budget one stops; larger budgets exclude the failed
joint canonical AST and may remember a different kept pair from its own sealed
search run. Gate failures and unverified rollback never authorize fallback.
This reuses the existing schema, journal and safety gates; no new persistence
authority or general learning-gain claim is introduced.

Validation: `node --test test/coder-pipeline-synthesis.test.js test/coder-arithmetic-synthesis.test.js`.
Learning checks: `node --test test/coder-pipeline-learning.test.js test/coder-multi-target-learning.test.js`.
