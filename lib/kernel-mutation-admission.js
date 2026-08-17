'use strict';

/**
 * The kernel's mutation admission call sites.
 *
 * Two of them so far, and they use the seam in deliberately different shapes
 * because the code around them differs:
 *
 *   admitLearn            gates, then returns a sealed payload the caller must
 *                         use -- the mutation itself runs later, downstream.
 *   admitCandidateIngest  wraps: the mutation runs inside the admit callback,
 *                         so everything it reaches is lexically within an
 *                         active admission.
 *
 * The wrapping shape is the stronger one and is preferred where the call site
 * allows it. `learn()` does not: its mutation is a long block that also owns the
 * critical section and the durable journal, and pulling that inside a callback
 * would have fused admission with durability -- the one thing Gate 2 ruled out.
 *
 * `kernel.learn()` is the single funnel for the knowledge-mutation family:
 * `learnDocument` and `learnAsync` both call it, and `runLearnUseCase` — where
 * that family's eight sink calls actually live — has exactly one caller, at
 * `kernel.js`. Gating here therefore gates the family.
 *
 * ## Why this owns the plugin transform too
 *
 * `docs/task-packs/p1b-gate2-hook-source-reality.md` established that
 * `_runBeforeLearn` is a plugin *transform* event, not an enforcement point:
 * plugins hand back the text and options that the write then uses. Admission
 * placed before it would approve a payload that plugins could still rewrite.
 *
 * So the two are one ordered step here, and the order is structural rather than
 * conventional: this function calls the transform and then admits its output.
 * There is no arrangement of the caller that can admit first, because the
 * caller never sees the untransformed payload at all.
 *
 *     _runBeforeLearn  (plugins may rewrite)
 *       -> ADMISSION   (payload is now final)
 *       -> critical section
 *       -> runMutationOnce / durable journal
 *       -> mutation
 *
 * ## Admission is not durability
 *
 * This runs strictly before `runMutationOnce`, and refuses with its own error
 * code. A refused admission and a `DURABLE_MUTATION_JOURNAL_UNAVAILABLE` are
 * different conditions — one is "this mutation may not happen", the other is
 * "this mutation cannot be recorded safely" — and an operator responds to them
 * differently. Collapsing them into one failure would lose that.
 *
 * ## What identity context actually exists here
 *
 * Routing this caller was meant to reveal that, and it did: callers pass
 * `opts.actor` (the CLI sends `cli-user`), plus `sourceType` and `sourceRef`.
 *
 * **None of that is promoted to an identity claim.** `actor` is a caller-supplied
 * label; treating it as identity would let the request describe who it is, which
 * is the property `lib/a2a/exchange-route.js` exists to deny and the first thing
 * P1-A's threat model rules out. It is recorded in the absence reason instead, so
 * the fact that a caller-supplied actor exists is visible to whoever later
 * decides what a real claim looks like.
 */

const { absent, createMutationAdmission } = require('./mutation-admission');

const LEARN_ACTION = 'kernel.learn';
const CANDIDATE_INGEST_ACTION = 'kernel.ingestCandidateClaim';
const DEFAULT_WORKSPACE = 'default';

function resolveWorkspace(opts) {
  return (typeof opts?.workspaceId === 'string' && opts.workspaceId.trim())
    ? opts.workspaceId.trim()
    : DEFAULT_WORKSPACE;
}

function seamFor(kernel, admission) {
  return admission || kernel._mutationAdmission || createMutationAdmission();
}

function refuse(outcome, what) {
  const error = new Error(`${what} refused by mutation admission: ${outcome.reason}`);
  error.code = 'MUTATION_ADMISSION_REFUSED';
  error.admissionReason = outcome.reason;
  return error;
}

const ABSENCE_REASONS = Object.freeze({
  identityClaim: 'kernel.learn callers pass opts.actor, a caller-supplied label; no receiver-owned identity claim reaches this seam yet',
  delegationContext: 'no delegation chain is modelled on the learn path',
  connectorContext: 'connector provenance travels in opts.sourceType/sourceRef and is not a verified connector context',
});

/**
 * Run the plugin transform, then admit the result.
 *
 * @returns {{ text: string, opts: object }} the sealed payload, produced by the
 *   admission itself. Its contents are exactly what `_runBeforeLearn` returned --
 *   admission observes rather than edits -- but it is only obtainable from here.
 * @throws when admission refuses — before the critical section is entered and
 *   before any durable machinery runs.
 */
function admitLearn(kernel, text, opts = {}, admission = null) {
  const ev = kernel._runBeforeLearn(text, opts);
  const nextText = ev.text;
  const nextOpts = ev.opts || opts;

  const outcome = seamFor(kernel, admission).admit({
    // The same fallback the downstream write would apply, resolved here so the
    // workspace is decided in the open (ADR-011) rather than defaulted deeper.
    workspaceId: resolveWorkspace(nextOpts),
    action: LEARN_ACTION,
    identityClaim: absent(ABSENCE_REASONS.identityClaim),
    delegationContext: absent(ABSENCE_REASONS.delegationContext),
    connectorContext: absent(ABSENCE_REASONS.connectorContext),
    // The admitted effect is the sealed payload itself. Nothing downstream can
    // obtain it another way, so `learn()` structurally cannot proceed on a
    // payload admission did not produce -- a stronger property than calling a
    // gate and being trusted to honour its answer.
  }, () => Object.freeze({ text: nextText, opts: nextOpts }));

  if (!outcome.admitted) throw refuse(outcome, 'learn');
  return outcome.result;
}

/**
 * Admit a candidate-claim ingest, running the mutation inside the admission.
 *
 * `kernel.ingestCandidateClaim` is the only production entry to
 * `routeCandidateClaim`, which owns all twelve of `lib/conflict-detector.js`'s
 * sink calls -- across three write families at once. Wrapping here therefore
 * puts knowledge, candidate and audit writes inside one active admission,
 * which is the first evidence that the seam is a genuine cross-family boundary
 * rather than a per-family one.
 *
 * It does **not** cover the candidate family. Two other production entries
 * reach `graph.addCandidateClaim` without passing here -- `kernel.addCandidateClaim`
 * and `lib/external-client-mutation-receipt-owner.js` -- and they remain debt.
 */
function admitCandidateIngest(kernel, opts, mutate, admission = null) {
  const outcome = seamFor(kernel, admission).admit({
    workspaceId: resolveWorkspace(opts),
    action: CANDIDATE_INGEST_ACTION,
    identityClaim: absent(ABSENCE_REASONS.identityClaim),
    delegationContext: absent(ABSENCE_REASONS.delegationContext),
    connectorContext: absent(ABSENCE_REASONS.connectorContext),
  }, mutate);

  if (!outcome.admitted) throw refuse(outcome, 'candidate ingest');
  return outcome.result;
}

module.exports = Object.freeze({
  ABSENCE_REASONS,
  CANDIDATE_INGEST_ACTION,
  DEFAULT_WORKSPACE,
  LEARN_ACTION,
  admitCandidateIngest,
  admitLearn,
});
