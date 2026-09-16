'use strict';

/**
 * Experience Core E3 — ExperienceVerifier (#2389, design #2380).
 *
 * The third Experience Core responsibility: the independent outcome
 * assessment and learning-admission judgement that the journal deliberately
 * does not perform. Structural integrity (the contract) and domain outcome
 * (this module) are separate on purpose: the journal never imports this
 * file. It receives the verifier's assessment as data — a `verification`
 * event — and records it. Assessment here is pure: no I/O, no storage, no
 * journal require.
 *
 * ## Why not reuse lib/verify.js
 *
 * That service checks kernel claims for the executor (contradictions,
 * numerics, semantics). This module answers a different question — "did an
 * independent party confirm this run's outcome, and may anything be learned
 * from it?" — with different inputs (run evidence plus verifier identity,
 * not a statement string). Sharing the name would merge two failure modes
 * that #2380 requires to stay apart.
 *
 * ## Independence (#2380)
 *
 * The weakest useful definition, made checkable: a verifier must not share
 * a failure mode with the thing it checks. The assessment carries both
 * sides (`executor` vs `channel`: tool, adapter, credentials), and the
 * verdict counts only when at least one dimension differs. A verifier that
 * calls the same tool, through the same adapter, with the same credentials
 * is a second opinion from the same witness and yields `unknown`, never
 * `verified`. Whether a verifier may itself be an LLM is answered by
 * labelling, not by refusal: transitive LLM use is recorded openly
 * (`llmInvolved`) and never changes the verdict by itself, per the E1 rule
 * that LLM usage is provenance, not a verdict.
 *
 * ## Verdict rules
 *
 * - Executor success alone never verifies. No assessment, or an assessment
 *   without a `verified` verdict, leaves `outcomeStatus: unknown`.
 * - Positive acceptance needs integrity, coverage, independent
 *   verification, provenance and permission together. Any one missing —
 *   including a verifier that is off or unavailable — is `unknown`, never
 *   positive. A verifier that is off produces `unknown` rather than
 *   silence, so faking one buys nothing.
 * - Disagreement (two assessments with different verdicts, or a verdict
 *   that conflicts with recorded evidence) is `needs_review`, never
 *   positive and never silently resolved.
 * - Tampering (integrity proof false, or evidence the assessment does not
 *   actually cover) is `unknown`: nothing downstream may cite it.
 * - Swap/test-deletion counterexamples fail by construction: an assessment
 *   naming an unknown verifier kind, or claiming coverage its evidence
 *   cannot support, is refused (`ok: false`) rather than judged.
 */

const { resolveLearningEligibility } = require('./contract');

/** The #2380 taxonomy. `none` is a result (`unknown`), not an absence. */
const VERIFIER_KINDS = Object.freeze({
  OBSERVATIONAL: 'observational',
  DIFFERENTIAL: 'differential',
  RE_EXECUTION: 're-execution',
  ATTESTATION: 'attestation',
  NONE: 'none',
});

const KNOWN_KINDS = Object.freeze(new Set(Object.values(VERIFIER_KINDS)));

const VERDICTS = Object.freeze({
  VERIFIED: 'verified',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Checkable independence: at least one of tool, adapter or credentials
 * must differ between the executor side and the verifier channel. Missing
 * channel information is not independence — it is `unknown`.
 */
function checkIndependence(assessment) {
  const executor = isRecord(assessment.executor) ? assessment.executor : {};
  const channel = isRecord(assessment.channel) ? assessment.channel : {};
  for (const dim of ['tool', 'adapter', 'credentials']) {
    if (channel[dim] === undefined || executor[dim] === undefined) {
      return { ok: false, code: 'independence_uncheckable' };
    }
  }
  const differs = ['tool', 'adapter', 'credentials']
    .some((dim) => String(channel[dim]) !== String(executor[dim]));
  return differs
    ? { ok: true }
    : { ok: false, code: 'shared_failure_mode' };
}

function validateAssessment(assessment) {
  if (!isRecord(assessment)) return { ok: false, code: 'invalid_assessment' };
  const verifier = isRecord(assessment.verifier) ? assessment.verifier : null;
  if (!verifier || !nonEmptyString(verifier.name) || !nonEmptyString(verifier.version)) {
    return { ok: false, code: 'invalid_verifier_identity' };
  }
  if (!KNOWN_KINDS.has(assessment.kind)) return { ok: false, code: 'unknown_verifier_kind' };
  if (!Object.values(VERDICTS).includes(assessment.verdict)) {
    return { ok: false, code: 'invalid_verdict' };
  }
  return { ok: true };
}

/**
 * Assess a run's outcome.
 *
 * `input` is `{ executionStatus, assessments }`. `executionStatus` is the
 * executor's own claim (`completed`/`failed`, possibly undefined) and can
 * never produce `verified` by itself. `assessments` is a list of verified
 * assessment data as described above; the journal appends the returned
 * record as a `verification` event.
 *
 * Returns `{ ok, outcomeStatus, learningEligibility, record }`. `ok: false`
 * means the assessment was refused (swap/kind/coverage counterexample),
 * not merely negative.
 */
function assessOutcome(input = {}) {
  const assessments = Array.isArray(input.assessments) ? input.assessments : [];
  const executionStatus = input.executionStatus;

  if (assessments.length === 0) {
    return {
      ok: true,
      outcomeStatus: 'unknown',
      learningEligibility: resolveLearningEligibility({ executionStatus }).eligibility,
      record: null,
    };
  }

  const verdicts = new Set();
  let primary = null;
  for (const assessment of assessments) {
    const valid = validateAssessment(assessment);
    if (!valid.ok) return { ok: false, code: valid.code };
    // A `none` kind honestly reports it verified nothing.
    if (assessment.kind === VERIFIER_KINDS.NONE) {
      verdicts.add(VERDICTS.UNKNOWN);
      continue;
    }
    const independence = checkIndependence(assessment);
    if (!independence.ok) {
      verdicts.add(VERDICTS.UNKNOWN);
      continue;
    }
    verdicts.add(assessment.verdict);
    if (!primary && assessment.verdict !== VERDICTS.UNKNOWN) primary = assessment;
  }

  // Disagreement is a result, not an error: needs_review, never positive.
  if (verdicts.size > 1) {
    const record = buildRecord(primary || assessments[0], 'needs_review', input);
    return {
      ok: true,
      outcomeStatus: 'unknown',
      learningEligibility: resolveLearningEligibility({
        executionStatus, outcomeStatus: 'unknown', verificationConflicting: true,
      }).eligibility,
      record,
    };
  }

  const verdict = verdicts.has(VERDICTS.VERIFIED) ? VERDICTS.VERIFIED
    : verdicts.has(VERDICTS.FAILED) ? VERDICTS.FAILED
      : VERDICTS.UNKNOWN;

  if (verdict === VERDICTS.UNKNOWN) {
    const record = buildRecord(primary || assessments[0], 'unknown', input);
    return {
      ok: true,
      outcomeStatus: 'unknown',
      learningEligibility: resolveLearningEligibility({ executionStatus }).eligibility,
      record,
    };
  }

  // A well-formed verdict still has to earn its status. A `verified`
  // verdict needs all five proofs together; a `failed` verdict needs
  // permitted failure evidence. Anything short degrades to `unknown`
  // rather than failing loudly — loud failure is reserved for malformed
  // assessments above, while a well-formed but insufficient one is simply
  // not a finding.
  const proofs = isRecord(primary.proofs) ? primary.proofs : {};
  if (verdict === VERDICTS.FAILED) {
    const sufficient = proofs.failureEvidence === true && proofs.permission === true;
    const outcomeStatus = sufficient ? VERDICTS.FAILED : 'unknown';
    const eligibility = sufficient
      ? resolveLearningEligibility({
        executionStatus, outcomeStatus, proofs: { failureEvidence: true, permission: true },
      }).eligibility
      : resolveLearningEligibility({ executionStatus }).eligibility;
    return {
      ok: true, outcomeStatus, learningEligibility: eligibility,
      record: buildRecord(primary, outcomeStatus, input),
    };
  }
  const fragment = {
    executionStatus,
    outcomeStatus: verdict,
    proofs: {
      integrity: proofs.integrity === true,
      coverage: proofs.coverage === true,
      verification: proofs.verification === true,
      provenance: proofs.provenance === true,
      permission: proofs.permission === true,
    },
  };
  const complete = Object.values(fragment.proofs).every(Boolean);
  const outcomeStatus = complete ? verdict : 'unknown';
  const eligibility = resolveLearningEligibility(
    complete ? fragment : { executionStatus }).eligibility;
  return {
    ok: true,
    outcomeStatus,
    learningEligibility: eligibility,
    record: buildRecord(primary, outcomeStatus, input),
  };
}

/** The assessment as the journal records it: identity, scope, evidence. */
function buildRecord(assessment, outcomeStatus, input) {
  if (!isRecord(assessment)) return null;
  return Object.freeze({
    verifier: Object.freeze({ ...(assessment.verifier || {}) }),
    kind: assessment.kind || null,
    verdict: assessment.verdict || null,
    outcomeStatus,
    evidence: isRecord(assessment.evidence) ? Object.freeze({ ...assessment.evidence }) : null,
    scope: isRecord(assessment.scope) ? Object.freeze({ ...assessment.scope }) : null,
    channel: isRecord(assessment.channel) ? Object.freeze({ ...assessment.channel }) : null,
    executor: isRecord(assessment.executor) ? Object.freeze({ ...assessment.executor }) : null,
    llmInvolved: assessment.llmInvolved === true,
    executionStatus: input ? input.executionStatus || null : null,
  });
}

module.exports = Object.freeze({
  VERIFIER_KINDS,
  VERDICTS,
  checkIndependence,
  validateAssessment,
  assessOutcome,
  buildRecord,
});
