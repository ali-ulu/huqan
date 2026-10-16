# Multi-target synthesis

Status: implemented in the Coder synthesis path; bounded independent numeric
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
`array-fold` synthesis grammar and validation. Named functions can declare
`functionName` as in single-target synthesis. Paths must be distinct and pass
the existing root containment and ordinary mutation gate. This mode accepts
no supplied replacement text or sequence steps.

All retained target candidates are combined into sequence proposals. A child
search with omitted matching candidates, or a product exceeding the existing
eight-candidate loop cap, is refused with `SYNTHESIS_MULTI_TARGET_OVER_CAP`;
there is no silent Cartesian truncation. A failed test rolls back the whole
sequence before the next proposal. Training inputs do not substitute for the
independent declared test.

This mode does not yet persist or reuse a multi-target method: `rememberFile`
and `reuseMemory` are rejected rather than silently routed into the existing
single-target record format. It does not infer dependencies between targets,
support arbitrary source grammars, or generate requirements from natural text.

Focused checks: `node --test test/coder-multi-target-synthesis.test.js
test/coder-arithmetic-synthesis.test.js`. Native coverage includes an
unauthorized attempt, two successful synthesized files, and independent
acceptance failure restoring both files. Pure coverage includes unchanged
source files, invalid/duplicate paths, unsupported record options and a real
array-fold search whose omitted matches would otherwise hide an over-budget
Cartesian set.
