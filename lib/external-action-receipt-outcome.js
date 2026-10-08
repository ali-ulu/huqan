'use strict';

// Outcome-receipt side of lib/external-action-receipt.js (#2120): effect
// verification, the outcome receipt builder and the outcome-review flow.
// Moved verbatim; shaping helpers come from
// lib/external-action-receipt-admission.js and persistence stays in the entry.
const { FILE_EFFECT_SENSOR_VERSION, observeFile, compareObservations, isObserved } = require('./file-effect-sensor');
// The canonical receipt sealers live in the admission module: requiring them
// from there (same ring) instead of from Application-ring modules keeps the
// split from adding layer violations the entry did not already carry (#2120).
const {
  buildCanonicalReceiptPayload,
  hashCanonicalReceiptPayload,
  fromMcpDecision,
} = require('./external-action-receipt-admission');
const {
  EXTERNAL_ACTION_GUARD_VERSION,
  nowIso,
  digest,
  receiptId,
  trimReceiptText,
  envelopeDestination,
  receiptIdentity,
} = require('./external-action-receipt-admission');
const { CAPTURED_OUTCOME_STATUS, DEGRADED_OUTCOME_STATUS, admissionReceiptHasDegradedGate } = require('./gate-outcome-history');
const { receiptRuleIdentity } = require('./receipt/receipt-rule-identity');

/**
 * How much the receipt actually knows about the effect it describes.
 *
 * An outcome receipt records what the executor *said* happened. Nothing in this
 * path watches the process, the filesystem or the network, so `status:
 * 'executed'` means "the caller reported success", not "we saw it succeed". The
 * two are not the same claim, and a reader holding only the receipt could not
 * previously tell them apart.
 *
 * The distinction already exists one field over, for identity: `metadata.host`
 * carries what the host said about itself and is kept apart from `identity`,
 * which is deployment-attested, so an auditor can separate "Codex told us it
 * was this agent" from "this identity was verified". This applies the same rule
 * to the effect.
 *
 *   none      no effect to describe -- the action was blocked before it ran.
 *   reported  the executor supplied the outcome, and nothing checked it.
 *   observed  HUQAN measured the effect itself.
 *
 * `observed` now has one producer: lib/file-effect-sensor.js. When an action
 * names a file, the guard digests it at admission and again at outcome, both
 * readings taken from the filesystem, so the conclusion does not depend on
 * what the executor said. Everything else is still `reported` -- a command
 * with no file target, a network call, an action whose file was too large to
 * digest or could not be read. An observation that could not be taken is never
 * reported as one that was.
 *
 * What it does not establish is that the change was the *right* one. A file
 * that changed is evidence an effect occurred, not that the goal was met; a
 * file that did not change is not proof of failure, since an action can
 * legitimately be a no-op. `metadata.fileEffect` carries the readings so a
 * reader can see which of those they are looking at.
 *
 * Deliberately in `metadata` rather than at the top level. The canonical
 * payload is a fixed projection: a new top-level key is a schema version, the
 * way `trustRoot` was for v2, and would change the hash of every receipt and
 * every chain built on them. `metadata` passes through verbatim in both the v1
 * and v2 projections, and this receipt already keeps `outcomeStatus` and
 * `outputDigest` there. Promoting it belongs with the next version bump, which
 * needs conformance vectors first (#1820).
 */
const EFFECT_VERIFICATION = Object.freeze({
  NONE: 'none',
  REPORTED: 'reported',
  OBSERVED: 'observed',
});

function effectVerificationFor(outcomeStatus, fileEffect) {
  // Blocked means the guard refused before execution, so there is no effect
  // whose verification could be claimed either way. A `captured` outcome is the
  // same: the gate faulted before a decision, so nothing ran (#3500).
  if (outcomeStatus === 'blocked' || outcomeStatus === 'captured') return EFFECT_VERIFICATION.NONE;
  // `observed` is earned only when both readings were actually taken. An
  // observation we could not make must never be reported as one we did, so
  // anything indeterminate falls back to what the executor said.
  return fileEffect && isObserved(fileEffect.observation)
    ? EFFECT_VERIFICATION.OBSERVED
    : EFFECT_VERIFICATION.REPORTED;
}

/**
 * The second reading, and what the pair says happened.
 *
 * Returns null when the action named no file, or when the admission receipt
 * carries no first reading -- an outcome recorded against an older receipt
 * still works, it simply stays `reported`.
 */
function observeFileEffect(envelope, admissionReceipt) {
  const metadata = admissionReceipt && admissionReceipt.metadata;
  const before = metadata && metadata.fileBefore;
  // A malformed first reading measures nothing.
  if (!before || typeof before !== 'object' || typeof before.state !== 'string') return null;
  // Effect binding (#1866): the outcome must belong to the admission it cites
  // -- same invocation, same workspace, same pinned file. A reading pair from
  // two different actions is not an observation of either, so anything
  // mismatched degrades to `reported` instead of producing `observed`.
  if (!envelope || envelope.invocationId !== admissionReceipt.admissionId) return null;
  if (envelope.workspaceId !== admissionReceipt.workspaceId) return null;
  const admittedTarget = metadata.fileTarget;
  const currentTarget = envelope.target && (envelope.target.resolvedPath || envelope.target.path);
  if (admittedTarget) {
    if (!currentTarget || currentTarget !== admittedTarget) return null;
  } else if (!currentTarget) {
    return null;
  }
  // The admission pinned the one absolute file it measured; the outcome reads
  // that same file, never a re-resolved envelope path, so both readings are of
  // one target (#1865). A receipt from before the pinning carries no fileTarget
  // and falls back to the envelope's resolved path.
  const targetPath = admittedTarget || currentTarget;
  const after = observeFile(targetPath);
  return { before, after, observation: compareObservations(before, after), sensor: FILE_EFFECT_SENSOR_VERSION };
}

/**
 * The outcome status for one recorded outcome (#3500 R45, #3617 R52).
 *
 * A `blocked` admission outcome is split in two. When the guard reached a
 * decision (a rule or a person refused) the status stays `blocked`. When the
 * guard itself faulted -- a thrown or malformed gate, failed closed -- the
 * status is `captured`: the action was never judged, and calling it `blocked`
 * would let the guard's own failure be read as a refusal by the outcome miners.
 *
 * A successful outcome is split too. When the guard was whole, the status is
 * `executed` -- a clean approval. When the admission it cites shows a gate
 * holding a degraded input (`enforced` review finding with a detail, the shape
 * lib/impact-budget-gate.js writes), the status is `executed_but_degraded`: the
 * action ran, but the guard allowed it while it could not measure what it was
 * asked to measure. Filing that as a clean `executed` would let the miners
 * learn a full approval from a half-made decision (#3617).
 *
 * Both faults are read from the admission receipt, which is the authority here,
 * so a caller cannot re-label a real refusal as a gate fault, or a clean allow
 * as degraded, by saying so in the outcome. A receipt from before these markers
 * existed carries no such finding and reads as it always did.
 */
function outcomeStatusFor(admissionReceipt, outcome) {
  if (outcome.status === 'success') {
    return admissionReceiptHasDegradedGate(admissionReceipt) ? DEGRADED_OUTCOME_STATUS : 'executed';
  }
  if (outcome.status !== 'blocked') return 'failed';
  return admissionReceiptHasGateFault(admissionReceipt) ? CAPTURED_OUTCOME_STATUS : 'blocked';
}

// The marker `external-action-receipt-admission.js#safeFinding` writes on a
// finding that recorded a gate error; the admission receipt carries it as
// `metadata.findings[].error`. Reading the receipt's own marker keeps this
// module from depending on the guard's reason vocabulary directly.
const GATE_FAULT_MARKER = 'gate_error';

function admissionReceiptHasGateFault(admissionReceipt) {
  const findings = admissionReceipt && admissionReceipt.metadata && admissionReceipt.metadata.findings;
  if (!Array.isArray(findings)) return false;
  return findings.some((finding) => finding && finding.error === GATE_FAULT_MARKER);
}

function buildExternalActionOutcomeReceipt(envelope, admissionReceipt, outcome = {}, options = {}) {
  if (!admissionReceipt || typeof admissionReceipt !== 'object' || !admissionReceipt.receiptId) {
    throw new TypeError('buildExternalActionOutcomeReceipt requires an admission receipt');
  }
  const createdAt = nowIso(options);
  const outcomeStatus = outcomeStatusFor(admissionReceipt, outcome);
  const fileEffect = observeFileEffect(envelope, admissionReceipt);
  // The admission receipt is the authority on identity: an outcome must not be
  // able to re-attribute an action to a different agent after the fact.
  const identity = admissionReceipt.metadata?.identity || receiptIdentity(envelope);
  const receipt = {
    receiptId: receiptId('xact_out', [envelope.invocationId, admissionReceipt.receiptId, outcomeStatus, createdAt]),
    receiptKind: 'external_action_outcome_receipt',
    decision: admissionReceipt.decision,
    status: outcomeStatus,
    admissionId: envelope.invocationId,
    workspaceId: envelope.workspaceId,
    actor: envelope.agent.name,
    agentId: identity.agentId,
    memoryDraftId: 'not_applicable',
    provenanceId: admissionReceipt.provenanceId,
    trustPolicyVersion: EXTERNAL_ACTION_GUARD_VERSION,
    approvalId: admissionReceipt.approvalId || 'not_applicable',
    approvalStatus: admissionReceipt.approvalStatus || 'not_required',
    reason: String(outcome.reason || outcomeStatus),
    riskScore: admissionReceipt.riskScore,
    createdAt,
    metadata: {
      admissionReceiptId: admissionReceipt.receiptId,
      admissionReceiptHash: admissionReceipt.receiptHash || '',
      identity: { ...identity, capabilities: [...identity.capabilities], delegationChain: [...identity.delegationChain] },
      autonomy: admissionReceipt.metadata?.autonomy ? { ...admissionReceipt.metadata.autonomy } : null,
      // Carried from the admission for the same reason `identity` is: an
      // outcome must not be able to re-point an action at a different site
      // after the fact. Falls back to the envelope only when the outcome is
      // recorded against a receipt written before this field existed.
      toolName: trimReceiptText(admissionReceipt.metadata?.toolName) || trimReceiptText(envelope.tool && envelope.tool.name),
      destination: admissionReceipt.metadata?.destination === undefined
        ? envelopeDestination(envelope)
        : admissionReceipt.metadata.destination,
      monitoring: envelope.postActionMonitoring ? { ...envelope.postActionMonitoring } : null,
      outcomeStatus,
      effectVerification: effectVerificationFor(outcomeStatus, fileEffect),
      // The two readings behind an `observed` verdict, so a reader can see what
      // was measured rather than take the label on trust. Null when the action
      // named no file or the admission receipt carried no first reading.
      fileEffect,
      outputDigest: digest(outcome.output ?? null),
      // R54 (#3619): the rule that produced this outcome is the outcome status
      // itself; its version is the guard version. Carried in metadata so the
      // frozen v1 canonical schema is untouched (ADR-009).instanceId is this
      // receipt's own id.
      ruleIdentity: receiptRuleIdentity({
        policyVersion: EXTERNAL_ACTION_GUARD_VERSION,
        ruleId: outcomeStatus,
        instanceId: receiptId('xact_out', [envelope.invocationId, admissionReceipt.receiptId, outcomeStatus, createdAt]),
      }),
    },
  };
  const verdict = fromMcpDecision({ decision: admissionReceipt.decision, reason: receipt.reason }).verdict;
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict });
  return Object.freeze({ ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) });
}

/**
 * Human review of a recorded outcome (#2137, part C of #2110).
 *
 * An outcome receipt is frozen and hash-signed the moment it is written, so a
 * review decision can never be spliced into it after the fact -- mutating it
 * would break the hash and with it every chain built on the trail. The review
 * therefore lands as its own receipt beside the outcome, bound to it by id and
 * by the outcome's recorded hash.
 *
 * `external_action_review_receipt` is already the kind an *admission* that
 * needs review produces, so this one is named for what it reviews: an
 * `external_action_outcome_review_receipt` always attaches to an existing
 * `external_action_outcome_receipt`.
 *
 * reviewDecision, reviewActor and reviewAt live in `metadata`, not at the top
 * level: the canonical payload is a fixed projection and a new top-level key
 * is a schema version (see the effectVerification note above). Metadata
 * passes through verbatim, so the three fields stay covered by the receipt
 * hash. The decision still speaks the canonical verdict vocabulary -- no new
 * verdict value is invented; `fromMcpDecision` maps the projected decision.
 */
const OUTCOME_REVIEW_DECISIONS = Object.freeze(['approved', 'rejected', 'escalated']);
const REVIEW_ACTOR_LIMIT = 200;
const REVIEW_NOTE_LIMIT = 500;

function outcomeReviewDecision(reviewDecision) {
  return reviewDecision === 'approved' ? 'allow' : reviewDecision === 'rejected' ? 'block' : 'review';
}

/**
 * Rebuild and compare a receipt's hash from its own stored canonical fields.
 * Returns false for anything that does not re-verify -- a corrupted or
 * tampered line is never evidence, it is noise to be skipped.
 */
function receiptHashVerifies(receipt) {
  const { receiptHash, ...canonicalSource } = receipt;
  if (typeof receiptHash !== 'string' || !receiptHash) return false;
  try {
    const verdict = fromMcpDecision({ decision: receipt.decision, reason: receipt.reason }).verdict;
    return hashCanonicalReceiptPayload(buildCanonicalReceiptPayload(canonicalSource, { verdict })) === receiptHash;
  } catch (_) {
    return false;
  }
}

function buildExternalActionOutcomeReviewReceipt(outcomeReceipt, review, options = {}) {
  if (!outcomeReceipt || typeof outcomeReceipt !== 'object' || !outcomeReceipt.receiptId) {
    throw new TypeError('buildExternalActionOutcomeReviewReceipt requires the outcome receipt under review');
  }
  if (outcomeReceipt.receiptKind !== 'external_action_outcome_receipt') {
    throw new TypeError(
      `an outcome review attaches to an external_action_outcome_receipt, got ${String(outcomeReceipt.receiptKind)}`,
    );
  }
  // The binding is only as good as the thing it binds to: if the outcome's
  // own hash no longer verifies, whatever this review would attach to is not
  // the receipt that was written, and the review is refused rather than
  // blessing a doctored record.
  if (!receiptHashVerifies(outcomeReceipt)) {
    throw new Error('Outcome receipt hash does not verify; refusing to attach a review');
  }
  const reviewDecision = typeof review?.decision === 'string' ? review.decision.trim() : '';
  if (!OUTCOME_REVIEW_DECISIONS.includes(reviewDecision)) {
    throw new TypeError(`review.decision must be one of ${OUTCOME_REVIEW_DECISIONS.join(', ')}`);
  }
  const reviewActor = typeof review?.actor === 'string' ? review.actor.trim().slice(0, REVIEW_ACTOR_LIMIT) : '';
  if (!reviewActor) {
    throw new TypeError('review.actor is required: a review without a named reviewer reviews nothing');
  }
  const note = typeof review?.note === 'string' ? review.note.trim().slice(0, REVIEW_NOTE_LIMIT) : '';
  const createdAt = nowIso(options);
  const decision = outcomeReviewDecision(reviewDecision);
  const receipt = {
    receiptId: receiptId('xact_rvw', [outcomeReceipt.receiptId, reviewDecision, reviewActor, createdAt]),
    receiptKind: 'external_action_outcome_review_receipt',
    decision,
    status: 'reviewed',
    admissionId: outcomeReceipt.admissionId,
    workspaceId: outcomeReceipt.workspaceId,
    actor: reviewActor,
    agentId: outcomeReceipt.agentId || '',
    memoryDraftId: 'not_applicable',
    provenanceId: outcomeReceipt.provenanceId,
    trustPolicyVersion: outcomeReceipt.trustPolicyVersion || EXTERNAL_ACTION_GUARD_VERSION,
    approvalId: outcomeReceipt.approvalId || 'not_applicable',
    approvalStatus: outcomeReceipt.approvalStatus || 'not_required',
    reason: note || `outcome_review_${reviewDecision}`,
    riskScore: outcomeReceipt.riskScore,
    createdAt,
    metadata: {
      reviewDecision,
      reviewActor,
      // The moment the review was recorded -- the same reading the receipt
      // itself carries as createdAt, so the two can never drift apart.
      reviewAt: createdAt,
      outcomeReceiptId: outcomeReceipt.receiptId,
      outcomeReceiptHash: outcomeReceipt.receiptHash,
      actionActor: outcomeReceipt.actor || '',
      note,
      // R54 (#3619): the rule that produced this review is the review decision;
      // its version is inherited from the outcome under review. In metadata, so
      // the frozen v1 canonical schema is untouched (ADR-009).
      ruleIdentity: receiptRuleIdentity({
        policyVersion: outcomeReceipt.metadata?.ruleIdentity?.policyVersion || EXTERNAL_ACTION_GUARD_VERSION,
        ruleId: decision,
        instanceId: receiptId('xact_rvw', [outcomeReceipt.receiptId, reviewDecision, reviewActor, createdAt]),
      }),
    },
  };
  const verdict = fromMcpDecision({ decision, reason: receipt.reason }).verdict;
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict });
  return Object.freeze({ ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) });
}

module.exports = {
  EFFECT_VERIFICATION,
  effectVerificationFor,
  observeFileEffect,
  buildExternalActionOutcomeReceipt,
  OUTCOME_REVIEW_DECISIONS,
  outcomeReviewDecision,
  receiptHashVerifies,
  buildExternalActionOutcomeReviewReceipt,
};
