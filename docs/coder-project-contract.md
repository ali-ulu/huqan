# Model-free Coder project contract — proposed

## Computed HTTP project recipe

Computed routes may declare a `pipeline` of 2-4 computation route paths, for
example `["/square", "/square", "/sum"]`. Each stage receives the previous
stage's array result; every intermediate stage must be `array-map`. The final
stage may be any supported computation family. Forward references and repeated
base methods are supported. Pipelines cannot reference pipelines or object
composition routes, so the declared chain cannot recurse. Optional `inputField`
binds the outer request only; internal stages receive arrays.

The array form explicitly declares the chain. Alternatively, a pipeline can be
an object with exactly `family` and `examples`. Its family is the final result's
computation family, and its 3-32 distinct training examples include the empty
array. Coder infers the ordered chain from these training answers alone. It
enumerates every type-compatible chain of 2-4 already selected base methods,
with at most 2,793 chains under the eight-route limit. Identical method ASTs
are deduplicated across route aliases. No matching chain is refused as
`PROJECT_COMPUTE_PIPELINE_NO_SOLUTION`; multiple distinct matching chains are
refused as `PROJECT_COMPUTE_PIPELINE_AMBIGUOUS`. Acceptance answers cannot
choose between them. The plan records selected stages, enumeration count,
budget and matching-chain count. This search does not infer recursion or new
base operators.

Existing learned methods are selected from their own training examples, with
zero base-program enumeration during sealed reuse. Pipeline order inference
first checks saved chain methods. Exactly one matching saved chain is reused
with `source: "memory"`, zero order enumeration and zero search budget. Multiple
distinct matching saved chains are refused as
`PROJECT_COMPUTE_PIPELINE_MEMORY_AMBIGUOUS`. If no saved chain applies, the
selected base methods still permit the bounded training-only order search,
reported as `source: "training"`; no new base AST is searched on the warm path.
Saved chain stages must correspond to base methods selected in the target,
so renamed route paths can bind the same algorithm without altering its AST.
The resulting chain can express algorithms
outside an individual family's fixed grammar, such as fourth-power sums built
from two applications of a square method followed by a sum method. This is
composition of supplied or learned base methods, not evidence of unrestricted
algorithm discovery or general learning gain.

Pipelines require their own 3-32 independent acceptance cases. For inferred
chains these inputs must also be disjoint from the pipeline's own training set.
The input reaching
each stage, including transformed intermediate inputs, must not match that
stage's training inputs. This overlap check occurs after method selection and
does not use expected answers. Native HTTP tests must independently verify the
pipeline output; an incorrect answer rolls back generated files. Each stage
input retains the 128-element, +/-1,000,000 integer and signed-zero limits, and
arithmetic overflow is refused. A valid standalone map output beyond the input
bound cannot silently widen the next stage's contract. Saved memory retains
both base methods and a closed `pipeline` AST for each positively verified
chain. A chain contains 2-4 cloned, frozen base ASTs; nested pipelines and
scalar intermediate stages are refused. Loading a saved chain must reproduce
that exact chain from the positively verified source specification and match
every native generated-file hash. Recomputing a record checksum does not
authorize a different valid chain. Older base-only records remain readable,
but have no saved chain to reuse. Fresh target HTTP acceptance remains required;
failed targets do not overwrite or promote the source record. This is bounded
method learning and transfer, not evidence of general learning gain.

`node_computed_json_api` extends the local project path with POST computations
inferred from bounded array input/output examples. It emits six exact files:
`package.json`, `routes.json`, `src/server.js`, `src/logic.js`,
the generated `test/` directory containing `api.test.js`, and `README.md`. The existing five-file GET recipe remains
available. No model, dependency, code string, or caller-supplied expression is
accepted by this recipe.

Each route declares `compute.family: "array-fold"`, `examples`, and
`acceptanceExamples`. Training requires at least three distinct arrays,
including the empty array. Acceptance requires at least three distinct arrays
disjoint from training. Both sets contain at most 32 cases; arrays contain at
most 128 integers bounded by 1,000,000 in magnitude. Signed zero is refused.
The first matching program is selected from the fixed 7,062-program search
using training only. Acceptance does not select or repair the program.

The generated service accepts a JSON array and returns `{ "result": number }`.
Computed routes may optionally declare `inputField: "values"` to accept exactly
one own JSON object field containing that same integer array, for example
`{ "values": [2, 3] }`. Field names contain 1-32 ASCII letters, digits or
underscores, begin with a lowercase letter, and cannot be `constructor` or
`prototype`. Missing, extra or wrongly typed fields are refused with HTTP 400;
the existing array, integer and body-size limits still apply. Routes without
`inputField` retain the array request shape. A project may mix both shapes.
Training and independent acceptance examples remain arrays; this field binds
the request shape, not algorithm selection. Sealed methods can transfer across
these request shapes, with fresh native HTTP acceptance required on the target.

Computed projects may also declare a composition route with `compose`, for
example `{ "total": "/sum", "positiveCount": "/count" }`, and its own
`acceptanceExamples`. Each of 2-4 result fields names an existing computation
route in the same project; forward references are supported. A composition
cannot target another composition, so cycles and nested dispatch are refused.
It applies the referenced programs to the same validated array and returns
`{ "result": { "total": 6, "positiveCount": 2 } }`. Field names use the same
closed naming rules as `inputField`. Acceptance expectations must contain
exactly the declared integer fields and their inputs must be disjoint from
every referenced program's training inputs. Acceptance never selects programs.
Cold computation plans also report `trainingQuestion`: a bounded diagnostic
over the retained candidate set, with at most 16 probe values and 128 distinct
non-training probes. Probe values come from the fixed -3..3 values and training
integers and their valid neighbors. A `witness` contains an input and differing
candidate predictions, never a chosen expected answer. CLI dry-run displays
this as a question; the intended result must come from an additional declared
requirement. Acceptance data never influences this diagnostic. Every report
sets `exhaustive: false` and records omitted candidates; a null witness is not
a uniqueness or correctness claim. The diagnostic does not alter selection,
native acceptance or permission. Sealed reuse adds no diagnostic search.
The eight-route cap includes composition routes. Sealed method memory retains
only the underlying computation ASTs; composition wiring is bound by the six
verified output hashes. Changed route order, names or request fields require
fresh native acceptance on reuse; a wrong composed result rolls back the target.
Every arithmetic intermediate must remain a safe integer. Invalid input,
oversized bodies, and computation overflow are refused. Initialization still
requires the explicit operator flag, a clean feature-branch source, an empty
separate target, a single-use permission bound to exact contents, native HTTP
tests, and independent readback. Failed acceptance rolls back the generated
files instead of trying another program against the same acceptance oracle.

This is a bounded local project capability, not evidence of arbitrary software
engineering, deployment readiness, or measured general learning gain.

Example requirement for a squares-total service:

```json
{
  "kind": "project_spec",
  "name": "squares-api",
  "archetype": "node_computed_json_api",
  "routes": [{
    "path": "/squares",
    "compute": {
      "family": "array-fold",
      "examples": [
        { "input": [], "expected": 0 },
        { "input": [2], "expected": 4 },
        { "input": [3, 4], "expected": 25 }
      ],
      "acceptanceExamples": [
        { "input": [-3, 8], "expected": 73 },
        { "input": [1, 1, 1], "expected": 3 },
        { "input": [20], "expected": 400 }
      ]
    }
  }]
}
```

Preview with `huqan coder create requirements.json --dry-run --json`.
To initialize an existing empty directory, additionally pass `--root <target>`,
`--initialize-project`, and `--source-root <clean-feature-repository>`.

This change selects a closed recipe from structured requirements. It calls no
language model and does not infer omitted requirements. It is the first recipe
in a broader software-development path, not evidence of general software design
or learning gain.

## Preview

`huqan coder create requirements.json --dry-run --json`

```json
{
  "kind": "project_spec",
  "name": "greeting-api",
  "archetype": "node_json_api",
  "routes": [{ "path": "/hello", "body": { "greeting": "Merhaba" } }]
}
```

The preview contains five planned files, the normalized request fingerprint,
requirements-to-test mapping and the declared HTTP acceptance command. It writes
nothing and starts no process. Unknown fields, archetypes and methods are
refused as `needs_human_decision`. Limits are eight unique literal routes,
16 KiB serialized requirements and bounded nested JSON values. Executable
properties and custom object/array prototypes are rejected.

The recipe emits a dependency-free Node JSON API bound to localhost, fixed
package metadata, route data, HTTP tests and a README. Tests embed the requested
responses independently of the runtime route file. They observe GET output,
404 and 405 using real HTTP. Storage, authentication, deployment and arbitrary
source generation remain unsupported requirements.

## Current execution boundary

The existing `--authorize` flag authorizes only ordinary source REVIEW. It does
not authorize package mutation or runtime entrypoints. This recipe is therefore
held unless the distinct, default-off initialization contract is selected.
The prepared opt-in is `--initialize-project --source-root <clean-feature-repo>`;
it accepts an existing empty target outside that source repository. The source
must be a real Git root with a committed HEAD, a feature branch and strictly clean
status. The permission is single-use and binds exact task bytes and canonical
paths; it cannot be supplied by task metadata.

This is a reviewable draft. It has been exercised only in isolated disposable
fixtures, not on a real project directory. Merging or activating this new policy
in main still requires the user's pending decision.

An isolated test fixture materializes the pure transform output, runs the actual
HTTP suite, and independently re-derives the refused candidate record. Mutating
the route response then fails both the HTTP suite and HEAD verification. This
proves recipe and verifier behavior. Separate fixture tests exercise the actual
opt-in CLI composition and observe independent verification before keeping the
result. The ordinary `--authorize` path remains refused.

## Decision proposal: narrowly scoped project initialization

The prepared draft is a separate explicit project-initialization permission,
not an expansion of `--authorize` or a global gate bypass. Before any write it
requires:

1. An explicit operator-approved `node_json_api` recipe version and exact spec
   hash, root and output paths.
2. An existing, genuinely empty, non-symlink target directory outside the HUQAN
   checkout; unknown repository state, `main`, dirty repositories and existing
   output paths must refuse. Initialization writes use exclusive file creation.
3. Re-derivation from the validated spec and matching fixed recipe outputs; all
   five operations must be create-only. No arbitrary command, extra file,
   dependency, npm lifecycle hook, package installation or release metadata is
   included.
4. A recorded permission evaluation before writes, exact fixed HTTP test command,
   post-test output hash checks, independent derivation verification and rollback
   on failure, including removal of newly created empty directories. Failed
   verification closes journal evidence with `kept: false`. The existing
   Experience journal remains the evidence store.
5. Permission is valid only for that single request. Unknown recipes, changed
   request/output, protected existing files and BLOCK reasons still refuse.

The gate also has a separately observed reporting defect: after aggregating
package REVIEW and runtime DRY_RUN_ONLY, the later low-risk test finding
overwrites the summary reason with `LOW_RISK_TESTS_ONLY`. The restrictive decision
is preserved. A repair must preserve the reason associated with the strongest
decision, with order-independent mixed-surface regression tests; fixing that
reason alone must not grant initialization permission.

Neither this draft nor a preview constitutes permission to initialize a real
project. That execution and merging the new contract into main require the
pending explicit user decision.

## Verified project method memory

For the computed recipe, `coder create <spec> --root <empty-target>
--initialize-project --source-root <clean-feature-checkout>
--journal <evidence.db> --project-memory <method.json>` enables explicit local
method memory. The JSON file must be outside both project roots, in an existing
real directory. It is bounded to 32 KiB, created exclusively, and never replaced.

A missing record permits the ordinary training-only search. Only successful
native HTTP acceptance, independent six-file readback, and a sealed verified
journal run can produce a record. Creation provenance comes from the native
single-use permission bound to the exact source checkout and recipe; it does
not pretend that previously absent output files were source inputs. Saved ASTs
must reproduce every file hash in that source run, including its acceptance
suite. The canonical saved-program set must exactly equal the programs actually
selected in that source project; unselected extra programs are refused even
when the JSON hash is recomputed. A self-consistent JSON hash alone is
insufficient authority.

An existing record must still validate against its original journal and
workspace. Reuse selects exactly one saved AST from the new training cases;
zero matches or ambiguity refuses without a fresh search. The new project can
have a different name and route and must pass its own independent HTTP
acceptance. Failed acceptance rolls back generated files without updating the
record. If saving fails after successful project verification, the command
reports a partial result and nonzero exit; the verified project may remain.

Repeat `--project-memory <method.json>` to reuse a pool of 2-4 independent
records from the same journal and workspace. The API accepts an array of 1-4
paths with the same reuse-only contract. Every named file must exist and pass
the full sealed-source verification; a missing, duplicate or invalid source
refuses before target writes. The pool retains each source hash and run ID,
deduplicates identical programs, and contains at most 32 programs. Distinct
programs that both match training remain ambiguous and refuse. No source file
is created or updated in pool mode; selection performs no fresh search and
the target still requires its own independent native HTTP acceptance.

This proves bounded cross-project method reuse and eliminates enumeration on
the warm selection path. It does not establish general learning gain or
unrestricted software engineering capability.

## Array-to-array synthesis

`compute.family: "array-map"` learns a length-preserving integer-array
transformation. Examples and acceptance expectations are arrays with exactly
the input length, up to 128 integers within +/-1,000,000. Training still needs
at least three distinct inputs including the empty array; acceptance remains
disjoint and never selects the program.

The fixed 4,105-expression grammar has an item, constants 0-3, and at most two
uses of `+`, `-`, `*` or `%`. It cannot read an accumulator, change output
length, call functions or execute supplied code. Every arithmetic intermediate
must be a safe integer; signed zero results are refused rather than silently
normalized over JSON. For example, observations `[] -> []`, `[2] -> [4]`,
and `[3,4] -> [9,16]` can infer squaring each item.

The HTTP result is `{ "result": [9,64] }` for input `[-3,8]`. Map methods can
mix with scalar fold methods and participate in structured composition
results, such as `{ "squares": [9,64], "total": 5 }`. Saved method memory
uses the same sealed-source and exact native-output proofs. Reuse requires a
unique training match, performs zero enumeration, and must pass the new
project's independent HTTP acceptance. This extends the supported output
types; it does not establish arbitrary array algorithms or general learning.

## Guarded array-fold synthesis

The computed recipe also accepts `compute.family: "array-guarded-fold"`.
Training infers both a guard and a bounded accumulator update. Guards compare
`item` with one integer threshold from -3 through 3 using `>`, `>=`, `<`, `<=`,
`===`, or `!==`. Nonmatching items are skipped. The update uses `acc`, `item`,
constants 0 through 3, and at most one `+`, `-`, `*`, or `%` operation. Seed is
fixed by the empty training case and must be -1, 0, or 1.

The cold search examines exactly 6,300 candidates using training only. The
first matching program is emitted as an actual conditional loop. No guard or
expression is supplied as executable text. Native HTTP acceptance and all
existing input, arithmetic and permission boundaries remain mandatory. For
example, cases `[] -> 0`, `[-1,0,-3] -> 0`, `[1,2,-3] -> 2`, `[3] -> 1`, and
`[0] -> 0` infer a positive-item count; acceptance must contain separate arrays.

Ordinary and guarded folds can coexist in one six-file project. Sealed method
memory records only programs actually selected and verified in that source
project. Warm selection uses only candidates belonging to each requested
family, refuses ambiguity or no match without cold fallback, and requires
fresh independent acceptance. This extends observable control-flow synthesis;
it does not establish unrestricted code generation or general learning gain.

## Thresholds learned from training

`compute.family: "array-threshold-fold"` extends conditional synthesis to safe
integer thresholds within +/-1,000,000. The threshold vocabulary contains the
fixed -3..3 values plus each training input integer and its adjacent integers
within those bounds. Acceptance inputs and expected values never add threshold
candidates. The vocabulary is sorted and deduplicated before searching.

More than 64 threshold candidates returns
`PROJECT_COMPUTE_THRESHOLD_SEARCH_OVER_CAP` before enumeration, rather than
silently dropping values. Each admitted threshold combines the same six
comparisons with 150 bounded accumulator updates, for at most 57,600 programs.
The plan reports the actual threshold count, search budget and enumeration.
The first training match must still pass independent native HTTP acceptance.
The earlier fixed-vocabulary guarded family keeps its 6,300-program contract.

For instance, boundary examples separating 1,000 from 1,001 can infer
`item > 1000` without executable guard text or a model. The verified program can
be reused on a new project with new arrays even when a fresh search would exceed
the threshold-vocabulary cap. Warm reuse retains input/spec bounds, selects one
verified candidate in the requested family, uses no new enumeration, and must
pass fresh acceptance. A paired native test holds the target spec unchanged:
fresh bounded search refuses while sealed-method reuse succeeds. This is one
observed bounded task result, not a general learning-gain estimate.

## Direct reuse of a verified chain

`pipeline: { family, examples, inferFromMemory: true }` may build a new chain
from verified primitive methods without declaring base routes or stage order.
It first attempts verified whole-chain reuse. Otherwise it examines all
compatible chains of length 2 through 4 in the supplied canonical repertoire.
If the complete search space exceeds 32768, it refuses before enumeration.
No new primitive ASTs are synthesized. Training selects a unique shortest
matching chain; equal shortest matches are ambiguous, even when acceptance
answers could distinguish them. Longer matching chains are counted separately
from the shortest matches. The policy and primitive/order counters are explicit
in the plan. Native independent acceptance still determines whether files stay.

Primitive lineage is reconstructed from verified source requirements and all
source chain stage positions. Target training projections are included when
checking actual acceptance-stage inputs. Missing lineage refuses. This mode
constructs and verifies a target; it does not persist the new assembled chain
as a separate learned method. The input memory files remain immutable.

Computation routes also support `family: "array-filter"`: infer an ordered
subsequence from 3 to 32 distinct training examples including the empty array.
The fixed threshold vocabulary of -3 through 3 is expanded only with training
input values and their adjacent integers, with a limit of 64 and a budget of at most
384 predicates. Oversized vocabularies refuse before search. Equivalent integer
boundaries share a canonical AST. Independent acceptance never selects a guard.
Filter outputs preserve the input order and duplicate values. Filters may be
intermediate or terminal chain stages; a chain ending in a map can return a
shorter array after filtering. Standalone maps still preserve array length.

A computation route may declare `pipeline: { family, examples, reuseOnly: true }`
with independent `acceptanceExamples`. This mode requires a verified project
method memory containing exactly one matching closed chain. Base computation
routes need not be redeclared. It performs no base-program or stage-order search;
missing or ambiguous methods are refused without a synthesis fallback.

The memory loader reconstructs training lineage only after verifying the sealed
source and all generated output hashes. Acceptance inputs must be independent
of source chain training and of every source training input for the same
canonical primitive, including inputs transformed at other stage positions.
Missing lineage is refused. Generated HTTP acceptance still decides whether
the target is kept; an incorrect result rolls back the generated files.


### Persisting a composed method

Use repeated `--project-memory <source.json>` flags with `--project-memory-out <new.json>` to save a verified composition. The output must be a new JSON file outside the source and generated project directories. Existing files are refused before project initialization. A failed independent acceptance test rolls back the project and creates no method record.

The version 1 record includes parent file identities, record hashes, sealed run IDs and sealed source hashes. Their ordered digest is bound into the permission-checked task identity and its sealed `run_started` event. Loading the new method re-verifies every parent, regenerates the source outputs and restores ancestor and intermediate-stage training inputs. Removing or replacing the parent bindings cannot downgrade a parent-bound record into a legacy record. Parent files and the original journal remain required; this is not a portable self-contained export.

Loading refuses cycles, more than four ancestry levels, or more than sixteen total records across a source pool. Reusing the saved whole chain searches zero new primitives. This supports bounded method composition and persistence, not unrestricted software synthesis or a measured general learning gain.


### Counting composition reuse work

A base route can opt into `compute.synthesizeOnMemoryMiss: true`. With a
verified memory pool, one training match is reused; zero matches trigger the
existing bounded search for the declared family. Multiple matches remain an
ambiguity refusal. Invalid sources and failed permission checks never trigger
this fallback. Acceptance answers do not select the new program.

Use `--project-memory-out <new.json>` to persist the new method after native
HTTP acceptance succeeds. Without that output option, the project is generated
but the loaded memory stays unchanged, and `projectMemory.state` is
`synthesized`. The default memory-only contract, `reuseOnly`, and
`inferFromMemory` retain their existing behavior.

`projectMemory.replaySearch` counts chain or primitive proposal enumeration while re-verifying the loaded source records, including recursive parents. Add it to the target plan's enumeration count when comparing search work. Zero target enumeration alone does not prove a reduction in total search.

Parent-bound saved chains are reconstructed from their closed ASTs and source-bound training inputs. Every stage must belong to a verified parent method or parent chain. Task identity, ancestry, independent native success and all generated output hashes remain mandatory before the proposal is admitted. Replaying the saved chain does not repeat its original candidate search.

`test/coder-composition-learning-gain.test.js` declares three unseen same-chain transfer tasks before source training, compares identical requirements and six generated file bodies under the same search cap, and counts source replay and additional chain training. Native acceptance remains mandatory in both arms. Search savings and native verification costs are separate measurements; this experiment cannot establish unrestricted software development or general learning gain.


### Accumulator-dependent decisions

`compute.family: "array-stateful-fold"` searches a closed 48-program vocabulary from training examples only. Each program chooses first-item or empty-result initialization, compares the current item with the accumulator using `>`, `<`, `===`, or `!==`, and conditionally retains the accumulator, selects the item, or assigns an integer from 0 through 3. The mandatory empty-input training example supplies the empty result. This is a bounded conditional loop rather than a built-in maximum/minimum operator.

Runtime inputs remain dense arrays of at most 128 signed-zero-free integers within plus or minus 1,000,000. Validation snapshots immutable programs; later caller mutation cannot change evaluation. Acceptance answers do not select a program. Successful native HTTP verification can persist the method through the existing sealed journal and output-hash gates. New-process transfer still requires independent target acceptance; wrong acceptance rolls back every generated file without changing the source memory.

The current tests establish maximum/minimum synthesis and same-method transfer. They do not establish general learning gains or arbitrary algorithm synthesis.

### Scalar method composition

A computed route can declare `composeScalar: { sources: ["/max", "/min"], examples: [...] }` and separate `acceptanceExamples`. Two through four scalar source routes supply learned programs. Training selects a unique shortest expression with at most two `+`, `-`, or `*` operations. Commutative operand order is canonicalized; distinct matching expressions are refused. Acceptance answers never choose the expression. Inputs retain the existing array bounds; scalar outputs and every intermediate must be signed-zero-free safe integers, so a difference may exceed the input bound.

The generated application tests the composition over HTTP. Existing sealed method records can persist it, bind source programs through the canonical AST, and reuse it without target expression enumeration. Parent-bound replay rebuilds provisional local training provenance from sealed requirements and admits it only after task binding, native verification and regenerated output hashes agree. Ancestor training inputs remain excluded from target holdouts. New primitive synthesis after a memory miss follows the declared fallback; its local provenance is distinguished from ancestor provenance.

The scalar composition tests cover source training, native HTTP, separate-process persistence, parent-bound new composition replay and failed-acceptance rollback. Equal-budget learning-gain measurement remains uncompleted; these tests do not establish general software synthesis.

The original scalar preregistration is insufficient: its empty-input holdout overlaps mandatory primitive training. Its original data is retained. A replacement three-task cohort declared in the test before source training compares identical requirements and generated file bytes with and without frozen extrema memory. The frozen record contains no scalar composition. With a 65,536 candidate cap per arm, the native CLI run measured 324 cold target evaluations versus 96 source-training plus 36 frozen-memory target evaluations, saving 192 evaluations after charging source training and replay. Cold and frozen arms required three and four native checks respectively. Frozen source bytes remained unchanged. This is bounded candidate-search savings, not a runtime-speed result or general learning gain. The original existing-system comparison and full three-arm protocol remain uncompleted.

### Discovering scalar sources from method memory

`composeScalar: { inferFromMemory: true, examples: [...] }` accepts a single target route without declared source routes. Verified primitive proposals are deduplicated and sorted by canonical program identity. The existing two-operation grammar searches the scalar pool by increasing operation count. Each complete depth must fit the remaining 4,000-candidate budget before that depth is generated or evaluated; a unique shorter solution does not require enumerating deeper expressions. `array-map` and `array-filter` methods, plus whole pipeline/composition proposals, are excluded from fresh primitive search. Over-budget depths are refused rather than partially searched. Unused sources are removed from the selected AST and indices are rewritten, so unrelated pool entries do not change method identity.

An already saved scalar composition can match target training without new enumeration. Every selected primitive requires reconstructed training provenance; cached reuse additionally requires the composition's own provenance. Acceptance inputs are checked against target and ancestor training after selection; failed independent acceptance does not select a replacement. Native CLI tests cover discovery from a sealed scalar primitive record without a stored composition, a generated single HTTP route, parent-bound persistence, new-process reuse and rollback with unchanged source records. This remains bounded method discovery and does not establish unrestricted coding or general learning gains.
