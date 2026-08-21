'use strict';

/**
 * The kernel's admission steps.
 *
 * One `admit*` function per kernel entry point routed through the mandatory
 * seam in `lib/mutation-admission.js`. It is named for the seam rather than for
 * `learn` because the learn family was only the first caller routed; the file
 * grows by entry point, not by family.
 *
 *   admitLearn              `kernel.learn`                -> knowledge family
 *   admitCandidateIngress   `kernel.ingestCandidateClaim` -> candidate + audit families
 *   admitAddCandidateClaim  `kernel.addCandidateClaim`    -> candidate family, direct write
 *
 * ## The candidate family's production entry points are all routed now
 *
 * Two of the three are here. The third is not a kernel caller at all and holds
 * its own seam:
 *
 *   `lib/external-client-mutation-receipt-owner.js` -- admits its durable
 *   commit directly, and is the only routed caller in the repository whose
 *   identity is receiver-verified before the seam is reached.
 *
 * One bound on that is load-bearing rather than decorative:
 *
 * 1. Routed is not enforced. The seam still evaluates no identity checks; it is
 *    a choke point, not a control. "Every candidate write passes a single
 *    boundary" is the claim -- not that any of them is being judged yet.
 *
 * ## The two candidate entry points do different things, and stay different
 *
 * `admitCandidateIngress` routes through `routeCandidateClaim`, which detects
 * conflicts and decides accept/reject/pending. `admitAddCandidateClaim` writes
 * the claim straight to storage with no conflict detection at all.
 *
 * That asymmetry is pre-existing and is **not** repaired here. Admission is a
 * choke point, not a control (see `lib/mutation-admission.js`), so routing a
 * caller must not change what the caller does. Making `addCandidateClaim`
 * detect conflicts would be a behaviour change smuggled in under a routing
 * change, and would make the routing impossible to review. What routing does
 * add is that the difference is now visible at the seam: the two arrive with
 * different `action` values, so a later policy can treat them differently
 * rather than having to rediscover that one of them skips conflict detection.
 *
 * -------------------------------------------------------------------------
 *
 * ## admitLearn
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
const { routeCandidateClaim } = require('./conflict-detector');

const LEARN_ACTION = 'kernel.learn';
const CANDIDATE_INGRESS_ACTION = 'kernel.ingestCandidateClaim';
const ADD_CANDIDATE_CLAIM_ACTION = 'kernel.addCandidateClaim';
const DEFAULT_WORKSPACE = 'default';

const ABSENCE_REASONS = Object.freeze({
  identityClaim: 'kernel.learn callers pass opts.actor, a caller-supplied label; no receiver-owned identity claim reaches this seam yet',
  delegationContext: 'no delegation chain is modelled on the learn path',
  connectorContext: 'connector provenance travels in opts.sourceType/sourceRef and is not a verified connector context',
});

const CANDIDATE_ABSENCE_REASONS = Object.freeze({
  identityClaim: 'candidate ingress carries opts.actor and claim.provenance.actor, both caller-supplied labels; no receiver-owned identity claim reaches this seam yet',
  delegationContext: 'opts.reviewedBy names a reviewer but models no delegation chain from one identity to another',
  connectorContext: 'connector provenance travels in claim.provenance.source/sourceRef and is not a verified connector context',
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

  const seam = admission || kernel._mutationAdmission || createMutationAdmission();
  const outcome = seam.admit({
    // The same fallback the downstream write would apply, resolved here so the
    // workspace is decided in the open (ADR-011) rather than defaulted deeper.
    workspaceId: (typeof nextOpts.workspaceId === 'string' && nextOpts.workspaceId.trim())
      ? nextOpts.workspaceId.trim()
      : DEFAULT_WORKSPACE,
    action: LEARN_ACTION,
    identityClaim: absent(ABSENCE_REASONS.identityClaim),
    delegationContext: absent(ABSENCE_REASONS.delegationContext),
    connectorContext: absent(ABSENCE_REASONS.connectorContext),
    // The admitted effect is the sealed payload itself. Nothing downstream can
    // obtain it another way, so `learn()` structurally cannot proceed on a
    // payload admission did not produce -- a stronger property than calling a
    // gate and being trusted to honour its answer.
  }, () => Object.freeze({ text: nextText, opts: nextOpts }));

  if (!outcome.admitted) {
    const error = new Error(`learn refused by mutation admission: ${outcome.reason}`);
    error.code = 'MUTATION_ADMISSION_REFUSED';
    error.admissionReason = outcome.reason;
    throw error;
  }
  return outcome.result;
}

/**
 * Admit the candidate-claim ingress, and route it.
 *
 * ## Why the routing happens *inside* the admitted effect
 *
 * `admitLearn` admits a sealed payload and hands it back for the caller to
 * write. That works there because the payload is the thing under control. Here
 * the thing under control is the *routing decision itself*: `routeCandidateClaim`
 * chooses accept / reject / pending and performs the corresponding writes in
 * one pass. Sealing an input and trusting the caller to route it afterwards
 * would leave admission observing a request rather than gating an effect.
 *
 * So the whole routing call is the admitted mutation:
 *
 *     ADMISSION
 *       -> routeCandidateClaim   (decides, then writes)
 *            -> candidate sinks  (graph.addCandidateClaim, addNode/addEdge)
 *            -> audit sink       (appendAudit)
 *
 * The consequence is the property worth having: the routed result is only
 * obtainable from `outcome.result`. A refusal returns before
 * `routeCandidateClaim` is entered, so no candidate row, no canonical edge and
 * no audit event exists for a refused ingress. That is stronger than the learn
 * path, where a caller holding a sealed payload could in principle write it.
 *
 * ## Three families, one seam
 *
 * `routeCandidateClaim` writes candidate rows, canonical graph edges (on the
 * accept path, via `acceptCandidateClaimJournaled`) and audit events. Routing
 * this one entry point therefore carries all three past the seam — which is the
 * evidence that the seam sits at a family-independent boundary and not at a
 * learn-shaped one.
 *
 * It does **not** make the candidate family routed; see the file header for the
 * two entry points that still bypass this.
 *
 * @returns {object} the `routeCandidateClaim` result.
 * @throws when admission refuses — before any routing or write occurs.
 */
function admitCandidateIngress(kernel, input = {}, opts = {}, admission = null) {
  const seam = admission || kernel._mutationAdmission || createMutationAdmission();

  // Resolved here, in the open, using the same precedence routeCandidateClaim
  // applies internally (opts wins over the claim, 'default' as the floor), so
  // admission decides on the workspace the write will actually land in.
  const workspaceId = [opts.workspaceId, input.workspaceId]
    .find((value) => typeof value === 'string' && value.trim())
    || DEFAULT_WORKSPACE;

  const outcome = seam.admit({
    workspaceId: workspaceId.trim(),
    action: CANDIDATE_INGRESS_ACTION,
    identityClaim: absent(CANDIDATE_ABSENCE_REASONS.identityClaim),
    delegationContext: absent(CANDIDATE_ABSENCE_REASONS.delegationContext),
    connectorContext: absent(CANDIDATE_ABSENCE_REASONS.connectorContext),
  }, () => routeCandidateClaim(kernel, input, opts));

  if (!outcome.admitted) {
    const error = new Error(`candidate ingress refused by mutation admission: ${outcome.reason}`);
    error.code = 'MUTATION_ADMISSION_REFUSED';
    error.admissionReason = outcome.reason;
    throw error;
  }
  return outcome.result;
}

/**
 * Admit the direct candidate-claim write.
 *
 * ## Availability is checked before admission, deliberately
 *
 * The caller's existing guard — graph missing, or missing the sink — runs
 * first and throws exactly as it did before. Admitting first would record an
 * admitted mutation that then could not happen, which puts noise into the one
 * signal the seam exists to carry. "There is nothing to write to" is an
 * infrastructure fault, not a decision about whether a write is permitted.
 *
 * ## The write is the admitted effect
 *
 * Same shape as `admitCandidateIngress`: the sink call runs inside the
 * callback, so a refusal means no row is stored. There is no sealed value to
 * hand back and therefore no way for a caller to write without admitting.
 *
 * @returns {unknown} whatever `graph.addCandidateClaim` returns, unchanged.
 * @throws the pre-existing availability Error, or on refusal.
 */
function admitAddCandidateClaim(kernel, candidate, opts = {}, admission = null) {
  const graph = kernel.graph;
  if (!graph || typeof graph.addCandidateClaim !== 'function') {
    throw new Error('Graph candidate claim storage is unavailable.');
  }

  const seam = admission || kernel._mutationAdmission || createMutationAdmission();

  // graph.addCandidateClaim resolves the workspace from four places in this
  // order. Mirrored here so admission decides on the workspace the row will
  // actually land in, rather than on a shorter approximation of it (ADR-011).
  const workspaceId = [
    opts.workspaceId,
    candidate?.workspaceId,
    candidate?.provenance?.workspaceId,
    candidate?.proposedEdge?.workspaceId,
  ].find((value) => typeof value === 'string' && value.trim()) || DEFAULT_WORKSPACE;

  const outcome = seam.admit({
    workspaceId: workspaceId.trim(),
    // Distinct from CANDIDATE_INGRESS_ACTION on purpose: this path performs no
    // conflict detection, and a policy that cannot tell the two apart could not
    // express that difference.
    action: ADD_CANDIDATE_CLAIM_ACTION,
    identityClaim: absent(CANDIDATE_ABSENCE_REASONS.identityClaim),
    delegationContext: absent(CANDIDATE_ABSENCE_REASONS.delegationContext),
    connectorContext: absent(CANDIDATE_ABSENCE_REASONS.connectorContext),
  }, () => graph.addCandidateClaim(candidate, opts));

  if (!outcome.admitted) {
    const error = new Error(`candidate claim write refused by mutation admission: ${outcome.reason}`);
    error.code = 'MUTATION_ADMISSION_REFUSED';
    error.admissionReason = outcome.reason;
    throw error;
  }
  return outcome.result;
}

module.exports = Object.freeze({
  ABSENCE_REASONS,
  ADD_CANDIDATE_CLAIM_ACTION,
  CANDIDATE_ABSENCE_REASONS,
  CANDIDATE_INGRESS_ACTION,
  DEFAULT_WORKSPACE,
  LEARN_ACTION,
  admitAddCandidateClaim,
  admitCandidateIngress,
  admitLearn,
});
