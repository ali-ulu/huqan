# Coder Experience runtime

`huqan coder task.json --root <repo> --journal <sqlite-file>` records the actual
execution and independent file read-back. Learned dispatch is explicitly selected
by the task's `experience` object. Without it, the existing coder operation runs.
The journal is required for learned dispatch; missing, open, mismatched or corrupt
source runs refuse the task before writing the target file.

Example task extension:

```json
{
  "experience": {
    "riskTier": "low",
    "candidates": [{
      "capabilityId": "docs-replacement",
      "sourceRunIds": ["verified-source-run"],
      "qualificationPaths": ["docs/drift-example.md", "docs/ambiguous-example.md"]
    }]
  }
}
```

The source must describe the same `replace_text` operation as the task. It must
be sealed and positively verified in the same workspace. Qualification reads
actual files: the pool must demonstrate rejection of drift and ambiguity, and
the current target must pass qualification. These paths are held-out examples;
they are read, never modified. The compiled procedure is registered by its hash
and dispatched through the shared trust, PEM and router modules. Every later
routed outcome contributes to trust, including negative runs omitted from the
source list. High-risk dispatch does not admit insufficient evidence.

For a low-risk task, `fallbackOnRefusal: true` explicitly permits the original
declared deterministic operation if a matching learned capability has become
ineligible. The ordinary coder write gate still applies. The journal records
the bypassed capabilities, and trust reconstruction restores their fallback
anti-erosion counters. Missing evidence and qualification errors do not fall back.

A candidate may explicitly specify `params` with `path`, `oldText`, `newText`
and a nonnegative `parentVersion`. The target and old text must match the task;
different replacement text must have its own matching verified source and
procedure version. The chosen operation changes the actual patch and its hash.

An optional `experience.canary` specifies `trialId`, `baselineCapabilityId` and
`candidateCapabilityId`. The journal persists the bound trial, request sequence
and measured execution, verification and routing costs. Every fifth eligible
trial request selects the candidate. Restart reconstructs the same sequence.
Comparison uses equal-sized chronological windows, including verification and
candidate overhead. Changing a trial binding or missing measurements refuses
dispatch. Passing a trial does not automatically promote a candidate.

Journal writes measure actual commit time, serialized bytes and event count.
The median write time and maximum event size feed the existing budget evaluator.
An exceeded budget refuses the disk effect but retains the refusal audit events.
Timing samples are process-local; restart does not invent historical write latency.

## Runtime ownership

The four helpers belong to Trust: they evaluate evidence, procedure eligibility,
sampling and journal budgets; the coder still owns the actual filesystem effect.
`budgeted-journal.js` is a public port consumed by the Platform composition roots
`agentRuntime.js` and `lib/coder/journal-store.js`. `coder-routing-runtime.js` is
the Trust port called by AgentAction's `lib/coder/apply-derivation.js` before its
existing write gate. `coder-canary-runtime.js` and `coder-trust-replay.js` are
called inside that Trust port and have no separate cross-context consumers.
The Trust helpers consume AgentAction's existing `write-cost-budget.js` budget
policy and `personal-execution-model.js` dispatch policy through explicit ports;
their established ownership is preserved.

## Publication evaluation

The publish workflow runs `scripts/check-release-evaluation.js` before publication.
It requires these repository variables:

- `HUQAN_RELEASE_EVALUATION_RECORD`: a JSON evaluation record plus `signature`.
- `HUQAN_RELEASE_EVALUATOR`: the pinned independent evaluator identity.
- `HUQAN_RELEASE_EVALUATOR_PUBLIC_KEY`: the evaluator's Ed25519 public key in PEM.

The evaluator builds a record with `buildReleaseEvaluationRecord` and signs the
UTF-8 `recordId` using Ed25519; `signature` is base64. The signing private key
belongs to the evaluator and is never supplied to this workflow.
`releaseEvaluationInputs(root)` exposes the required live commit and digests of
the selected security suite, tracked fixtures and lockfile. The evaluator must
run the evaluation independently and bind those inputs, counts, findings and
expiry. The gate verifies the signature, pinned identity, version, source,
digests, expiry, positive pass count and absence of failures or critical findings.
The evaluator must differ from implementation authors since the prior release.
Missing evaluation configuration blocks publication. This change does not set
repository variables or publish a release.
