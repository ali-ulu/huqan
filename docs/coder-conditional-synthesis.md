# Model-free conditional expression synthesis

The `conditional-expression` synthesis family repairs an existing named JavaScript
function from integer input/output examples. It searches a finite grammar; it does
not use a language model or generate an arbitrary project.

## Grammar and evidence

The request must identify `functionName`. A candidate contains one conditional:
its guard compares the parameter with a threshold using `>`, `>=`, `<`, `<=`,
`===` or `!==`. Raw thresholds range from -3 to 3. Canonical equivalent guards
can display thresholds -4 or 4. Each arm contains the parameter or literals 0–3
and at most one `+`, `-`, `*` or `%` operation. Thus `(2 + 2)` is allowed even
though a direct literal `4` is outside the arm grammar. Nested conditionals,
calls, properties, loops and free identifiers are unsupported. The reader also
accepts a nonconditional arithmetic baseline with at most two operations.

Supply 3–32 observations with at least three distinct inputs. Inputs and expected
outputs must be safe integers with absolute value at most 1,000,000; negative
zero is rejected. Both arms must have observation evidence. Evaluation is lazy:
an invalid unselected arm does not invalidate an observation.

The search reuses the arithmetic enumerator and existing closed integer programs.
It preserves branch syntax instead of folding constants outside the grammar.
Its reported budget is 472,017 search-stage visits: branch enumeration, guard
enumeration, branch checks and matching pairs. This counter excludes individual
example evaluations, parsing, memory replay, independent tests and rollback.
It is neither a time measurement nor a total execution cost.

At most eight candidates are retained, ranked by operation count and then text.
`omittedCandidates` reports other matching candidates. `searchComplete` means
finite enumeration finished, not that all candidates were retained, the solution
is unique, or behavior beyond the examples has been proved.

## Acceptance and learning

Source reading uses a closed AST and syntax compilation without executing target
JavaScript. The declared independent acceptance test does execute actual code
through the existing Coder process boundary; this is not a new sandbox.

Existing authorization, allowed paths, dry-run behavior, independent acceptance
and rollback remain required. Only a change retained after a successful independent
test can be remembered. Learning uses the existing source-sealed candidate format,
journal and qualification checks; there is no new memory schema or authority.

With `reuseMemory`, a later process can adapt a qualified method to a renamed
function and parameter. It rechecks current examples and the independent test.
A memory hit with `enumerated: 0` means fresh search was skipped, not zero work.
Memory attempts and fresh search share the candidate-attempt budget. A failed
attempt must roll back before another candidate can run; exhausted budgets stop.
Corrupt or incompatible source-sealed records are rejected.

The regression fixtures cover an absolute-value repair, unauthorized and dry-run
requests, failed acceptance rollback, restart reuse, renamed targets, forged records
and one-versus-two-attempt memory fallback. These establish bounded behavior,
not general JavaScript synthesis or production capacity.

Run the focused regressions with:

```sh
node --test test/coder-conditional-expression.test.js test/coder-conditional-learning.test.js
```
