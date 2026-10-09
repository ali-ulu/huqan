# Model-free Coder project contract — proposed

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
