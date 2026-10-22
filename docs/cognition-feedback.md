# Opt-in AgentV3 artifact feedback

The M7 application seam runs before each queued step is selected and observes
the result after execution. It reuses M1 perception, M2 prediction error, M8/M9
derived reward/value, the existing scheduler, and the prediction/outcome journal.
It adds no model, action authority, or second persistence store.

Enable the existing dependency-complete flags (`predictionError`, `reward`,
`value`, `percept`, `salience`) in `opts.cognition`, with
`opts.cognitiveScheduler`. Missing dependencies reject the cognition configuration;
salience without a scheduler records `salience_without_scheduler` and does not
change the queue. Without cognition the existing FIFO/scheduler behavior remains.

The host supplies `opts.cognitionFrame`: a complete K1 reference frame with
repo, branch, commit, environment, actor, time, goal and task. Its goal must match
the actual run goal. Different frames/workspaces never share learning signals.
Source/procedure versions belong in this explicit frame; they are not inferred.

For the supported independent observation, the host supplies
`opts.cognitionFileExpectations[step.id]` before execution:

```js
{
  workspaceId: 'default',
  path: '/absolute/path/to/artifact',
  expectedDigest: '64 lowercase SHA256 hex characters',
  sourceGroup: 'explicit-independent-source-group',
  riskScore: 0 // optional explicit pre-action risk estimate, 0..100
}
```

Tool input, step reports and `ok` never supply an expectation or a reward. The
existing bounded file sensor reads an existing regular file before and after the
step. A canonical target change, unreadable file or missing binding abstains.
The journal prediction binds workspace/run/step, frame, expectation hash, stable
target reference and percept key before execution. Outcome records inherit this
binding. The expected digest is detached from caller-owned options before the
step; changing options afterward cannot change the recorded expectation.

`confirmed` means only that this predeclared artifact digest matched; a changed
file alone does not establish success. `contradiction` means that digest did not
match. Neither is a claim of semantic correctness of the whole task. Missing
observations stay unknown. Replay returns the immutable journal outcome rather
than turning a later file change into a second outcome.

Both M2 and M9 consume the same immutable, workspace/frame-scoped pre-decision
journal snapshot. The optional `historyBoundary.priorDecisionIds` declares which
completed decisions were actually present before selection: it resolves equal
wall-clock milliseconds, not future timestamps. The pure ledger accepts this
ordering evidence from its caller; the application derives it from that snapshot.
Existing callers without it keep their exclusive timestamp boundary. No clock
is advanced and no post-decision outcome is used. M9 below-independent-support
values remain insufficient; an expected reward is never used as a probability.

Habituation counts completed observations with the same canonical target,
observed digest, expectation, action and frame percept key, not all uses of a
tool family. Stable target references connect repeated evidence even when a host
changes its source group. The scheduler carries only actually executed family
streaks across selections, preserves goal tiers and never removes deferred work.
Pending repairs are not reordered. Trace history keeps at most 32 records, each
with at most 64 reported candidates/value entries.

Focused verification:

```sh
node --test test/cognition-agent-seam.test.js test/cognition-feedback-runtime.test.js
```

The runtime fixture uses a fixed plan with the real AgentV3 loop, kernel, tools,
gates, sensor and storage. It checks observation-to-next-choice feedback and
fresh-process replay. It is a wiring characterization, not a held-out coding
success or production learning-gain measurement. G1's independent task/error
evaluation and preregistered Lab/G3 gain/default decisions remain unmeasured.
