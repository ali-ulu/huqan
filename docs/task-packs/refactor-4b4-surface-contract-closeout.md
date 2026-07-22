# REFACTOR-4B4 - Surface Contract Convergence Closeout

## Gate identity

- Repository: `ali-ulu/huqan`
- Canonical base: `032d2ba191d47b82974334c95c4c3bec44c7d31d`
- Previous checkpoint: `REFACTOR-4B3A_REST_UPLOAD_REVIEW_ONLY_CLOSEOUT_GREEN`
- Gate: `REFACTOR-4B4_BYPASS_NEGATIVE_AND_CLOSEOUT_EVIDENCE`
- Mode: documentation and evidence only

This record closes the REFACTOR-4B surface-convergence chain. It does not
change runtime behavior or authorize a new public API.

## Canonical chain

| Gate | Evidence | Result |
| --- | --- | --- |
| REFACTOR-4B1 | PR #68; parity and negative contract tests | Merged and green |
| REFACTOR-4B2 | PR #69; MCP agent lifecycle convergence | Merged at `1dc498ce6f7a194cf29b6df1dba079795cbc22cf` |
| REFACTOR-4B3A | PR #70; REST upload review-only boundary | Merged at `032d2ba191d47b82974334c95c4c3bec44c7d31d` |
| REFACTOR-4B3B | SDK and Workbench source-reality review | YAGNI/no runtime change required |

## Surface evidence

| Surface | Bypass-negative and failure evidence | Closeout status |
| --- | --- | --- |
| CLI | `cli.test.js` exercises the exact single-statement and document-import learn paths, requires the existing review response, and proves no Graph write. Unknown commands retain their bounded response. | Default learn paths do not add admission bypass metadata. |
| MCP | `test/refactor-4b1-surface-parity-contract.test.js` proves caller bypass metadata is stripped, review occurs before execution, an approved request executes once, and duplicate approval is idempotent. MCP lifecycle evidence proves per-call Agent storage closes without closing Kernel-owned resources. | Transport bypass closed for the tested MCP learn path. |
| REST | `server.test.js` covers `/yukle` and `/upload`, top-level and nested authority injection, empty input, malformed JSON, review outcome, and zero Graph-count change. `test/v4-trust-receipt-read-api.test.js` preserves receipt-read behavior without using REST caller approval as authority. | `TRANSPORT_BYPASS_CLOSED` for REST upload aliases. |
| SDK | `test/kernel-capability-execution-contract.test.js` proves `Kernel.runCapability` is preferred and the direct PluginManager path is used only when the governed public runner is absent. `lib/sdk.test.js` preserves the bounded legacy fallback and unknown-command failure. The SDK exposes no learn method. | Deliberate compatibility retention; no new executor or authority path. |
| Workbench-like inspectors | WB1 tests prove invalid/not-found/read-error handling, workspace filtering, clone isolation, and no receipt/Graph/audit mutation. WB2 tests prove input immutability and `source.readOnly: true` for terminal results. | Bounded read-only helpers; no approval or mutation authority. |

## Executed validation

At the REFACTOR-4B3A approved and merge-equivalent tree:

- focused REST/admission/receipt matrix: `128/128` pass;
- SDK/Workbench/capability matrix: `35/35` pass;
- full suite: `2077` total, `2048` pass, `0` fail, `29` skipped;
- Security Checks: success;
- Benchmark Regression, including Docker image build: success;
- merge tree equals the approved PR #70 head tree;
- canonical worktree: clean.

No additional test or runtime patch was required for REFACTOR-4B3B or this
closeout record.

## Register decisions

### RTG-002

Status remains:

`COVERAGE_AUDITED_COMPATIBILITY_OPEN`

The public in-process `Kernel.learn` compatibility pair
`admissionRequired: false` plus a non-empty `admissionBypassReason` is retained.
REFACTOR-4B proves that the inventoried CLI, MCP, REST upload, SDK, and
Workbench paths do not silently enable that pair. It does not remove or close
the public Kernel compatibility risk.

### RTG-006

Surface coverage differences are now executable evidence rather than a single
generic "gated" claim. Tool visibility, invocation authorization, process
startup authorization, and semantic mutation integrity remain distinct.
RTG-006 stays evidence-bound until the final REFACTOR-4H program audit.

## Deferred boundaries and non-claims

- `/api/ingest` is a separate authenticated capability surface; the REST
  upload closeout does not classify it as an upload alias.
- The SDK PluginManager fallback is not removed or promoted to a new public
  contract.
- Workbench-like inspectors are not a Workbench UI and do not create approval
  or mutation authority.
- `server.js` Graph lifecycle and projection reads, including `graph.load()`
  and direct `_edges` projection, are not closed here. They remain adapter/read
  boundary work for REFACTOR-4E.
- No claim is made that all production code has zero direct Graph access.
- Approval execution is not claimed to be atomic, crash-safe, or replay-safe.
- Audit and mutation are not claimed to share one durability boundary.
- No Policy Auditor, Policy Compiler, Action Integrity, productization, V5, or
  V6 work is started.
- REFACTOR-4 and the overall refactor program are not complete at this gate.

## Stop conditions for successors

Later gates must stop rather than reinterpret this closeout if they require:

- removal of the public Kernel admission bypass;
- removal of the SDK compatibility fallback without a consumer decision;
- a new generic executor, Graph snapshot, or mutable collection alias;
- verdict, receipt, envelope, workspace, or persistence semantic changes;
- a new schema, dependency, or public package surface.

## Closeout verdict

After this exact document is independently reviewed, merged, and verified on
canonical `main`, the valid verdict is:

`REFACTOR-4B_SURFACE_CONTRACT_CONVERGENCE_CLOSEOUT_GREEN`

The next roadmap gate is REFACTOR-4C. It must start from the separately
verified post-merge canonical SHA.
