'use strict';

// #3026 (Gate Outcome Learning Loop, PR 1/3): project the external-action
// outcome trail into evidence-ladder claims so the Dream loop can cite what the
// gate actually decided and what actually happened afterwards.
//
// Rules encoded here, fail-closed on data:
//   - a decision with no recorded outcome is silence, never evidence;
//   - an outcome whose admission is missing from the trail is an orphan;
//   - both the admission and the outcome must survive receipt-hash verification
//     before they advance a claim (the outcome hash covers the joined admission
//     reference, so tampering with the link breaks the outcome's own hash);
//   - `reported` stays a review candidate; only an admitted action (allow/review)
//     whose effect was independently observed reaches canonical evidence. A
//     blocked admission never promotes, even when an effect was observed: an
//     executed action behind a blocked admission is a guard bypass, not evidence.
// Verdict semantics mirror lib/residency-rule-miner.js exactly (executed →
// approved, blocked → refused, anything else → no verdict), because both the
// miner and this projection read the same trail and must not disagree.
//
// gateOutcomeCitations is the Dream-facing reader and is deliberately
// fail-open: a missing or unreadable trail contributes no evidence instead of
// breaking the loop.

const { isPlainObject } = require('./is-plain-object');
const { OUTCOME_RECEIPT_KIND } = require('./residency-rule-miner');
const { receiptHashVerifies } = require('./external-action-receipt-outcome');
const { readExternalActionReceiptsWithErrors } = require('./external-action-receipt-reader');
const { evidenceLadderAt } = require('./evidence-ladder');

const PROJECTION_VERSION = 'huqan-gate-outcome-projection-v1';
const MAX_CITATIONS = 8;

// Outcome-review receipts comment on an outcome; they are neither an admission
// nor an outcome for this projection and are ignored entirely.
const OUTCOME_REVIEW_RECEIPT_KIND = 'external_action_outcome_review_receipt';

const ADMITTED_DECISIONS = new Set(['allow', 'review']);

// Lib/residency-rule-miner.js rule (kept identical on purpose).
function verdictFor(status) {
  if (status === 'executed') return 'approved';
  if (status === 'blocked') return 'refused';
  return null;
}

function firstText(values, fallback) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

function effectVerificationOf(receipt) {
  const value = receipt.metadata?.effectVerification;
  // A receipt predating effect verification is treated as reported so it can
  // never be mistaken for an observed effect.
  return typeof value === 'string' && value ? value : 'reported';
}

function claimKeyFor(workspaceId, toolName) {
  return `${workspaceId}::${toolName}`;
}

/**
 * Project outcome-trail receipts into evidence-ladder claims.
 *
 * @param {object[]} receipts every receipt from the trail, oldest first
 * @param {object} [options]
 * @param {string} [options.workspaceId] restrict claims, pending entries and
 *   skips to one workspace (unscoped projections expose every workspace)
 * @returns {object} { projectionVersion, workspaceId, receiptCount, claims,
 *   pending, skipped }
 */
function projectGateOutcomeTrail(receipts, options = {}) {
  const trail = Array.isArray(receipts) ? receipts.filter(isPlainObject) : [];
  const workspaceFilter = typeof options.workspaceId === 'string' && options.workspaceId.trim()
    ? options.workspaceId
    : '';

  // Admission side, indexed both ways: by receiptId (how an outcome cites its
  // admission) and by invocation id (the miner's admissionId join, kept for
  // receipts written before metadata.admissionReceiptId existed).
  const admissions = [];
  const admissionByReceiptId = new Map();
  const admissionsByInvocation = new Map();
  for (const receipt of trail) {
    if (receipt.receiptKind === OUTCOME_RECEIPT_KIND) continue;
    if (receipt.receiptKind === OUTCOME_REVIEW_RECEIPT_KIND) continue;
    admissions.push(receipt);
    if (typeof receipt.receiptId === 'string' && receipt.receiptId) {
      admissionByReceiptId.set(receipt.receiptId, receipt);
    }
    if (typeof receipt.admissionId === 'string' && receipt.admissionId) {
      const bucket = admissionsByInvocation.get(receipt.admissionId) || [];
      bucket.push(receipt);
      admissionsByInvocation.set(receipt.admissionId, bucket);
    }
  }

  const referencedAdmissionIds = new Set();
  // An admission counts as resolved as soon as any in-scope outcome names it,
  // even when that outcome later fails verification: an invalid pair reports
  // through `skipped`, never as silence. This pre-pass uses only citation
  // fields, so it cannot promote anything — it only suppresses a false
  // "no outcome was ever recorded" entry.
  for (const receipt of trail) {
    if (receipt.receiptKind !== OUTCOME_RECEIPT_KIND) continue;
    if (workspaceFilter && receipt.workspaceId !== workspaceFilter) continue;
    const citedReceiptId = typeof receipt.metadata?.admissionReceiptId === 'string'
      && receipt.metadata.admissionReceiptId
      ? receipt.metadata.admissionReceiptId
      : '';
    if (citedReceiptId) {
      const admission = admissionByReceiptId.get(citedReceiptId);
      if (admission) referencedAdmissionIds.add(admission.receiptId);
      continue;
    }
    if (typeof receipt.admissionId === 'string' && receipt.admissionId) {
      const candidates = admissionsByInvocation.get(receipt.admissionId) || [];
      if (candidates.length === 1) referencedAdmissionIds.add(candidates[0].receiptId);
    }
  }

  const claimsByKey = new Map();
  const pending = [];
  const skipped = [];

  const joinAdmission = (receipt) => {
    const citedReceiptId = typeof receipt.metadata?.admissionReceiptId === 'string'
      && receipt.metadata.admissionReceiptId
      ? receipt.metadata.admissionReceiptId
      : '';
    if (citedReceiptId) {
      const admission = admissionByReceiptId.get(citedReceiptId);
      return admission
        ? { admission }
        : { error: 'the admission this outcome cites is not in the trail' };
    }
    if (typeof receipt.admissionId === 'string' && receipt.admissionId) {
      const candidates = admissionsByInvocation.get(receipt.admissionId) || [];
      if (candidates.length === 1) return { admission: candidates[0] };
      if (candidates.length > 1) {
        return { error: 'the invocation this outcome cites resolves to several admissions' };
      }
    }
    return { error: 'the outcome cites no admission that is in the trail' };
  };

  for (const receipt of trail) {
    if (receipt.receiptKind !== OUTCOME_RECEIPT_KIND) continue;
    if (workspaceFilter && receipt.workspaceId !== workspaceFilter) continue;

    if (!receiptHashVerifies(receipt)) {
      skipped.push({ receiptId: String(receipt.receiptId || ''), why: 'the outcome receipt hash does not verify' });
      continue;
    }

    const joined = joinAdmission(receipt);
    if (joined.error) {
      skipped.push({ receiptId: String(receipt.receiptId || ''), why: joined.error });
      continue;
    }
    const admission = joined.admission;
    if (typeof receipt.admissionId === 'string' && receipt.admissionId
      && typeof admission.admissionId === 'string' && admission.admissionId
      && admission.admissionId !== receipt.admissionId) {
      skipped.push({ receiptId: String(receipt.receiptId || ''), why: 'the outcome and the admission disagree on the invocation id' });
      continue;
    }
    if (!receiptHashVerifies(admission)) {
      skipped.push({ receiptId: String(receipt.receiptId || ''), why: 'the admission receipt hash does not verify' });
      continue;
    }

    const toolName = firstText([receipt.metadata?.toolName, admission.metadata?.toolName], 'unknown');
    const verdict = verdictFor(receipt.status);
    if (!verdict) {
      pending.push({
        receiptId: String(receipt.receiptId || ''),
        admissionId: String(receipt.admissionId || ''),
        workspaceId: receipt.workspaceId,
        toolName,
        why: `outcome status "${receipt.status}" carries no verdict; it is neither approval nor refusal evidence`,
      });
      continue;
    }

    const effectVerification = effectVerificationOf(receipt);
    const observed = effectVerification === 'observed';
    const admitted = ADMITTED_DECISIONS.has(admission.decision);
    const level = observed && admitted ? 'canonical_evidence' : 'review_candidate';
    const citation = {
      receiptId: receipt.receiptId,
      admissionReceiptId: admission.receiptId,
      admissionId: receipt.admissionId,
      receiptKind: receipt.receiptKind,
      workspaceId: receipt.workspaceId,
      toolName,
      toolKind: firstText([admission.metadata?.toolKind], 'unknown'),
      decision: receipt.decision,
      admissionDecision: admission.decision,
      outcome: receipt.status,
      verdict,
      effectVerification,
      observed,
      admitted,
      level,
    };

    const claimKey = claimKeyFor(receipt.workspaceId, toolName);
    let claim = claimsByKey.get(claimKey);
    if (!claim) {
      claim = {
        claimKey,
        workspaceId: receipt.workspaceId,
        toolName,
        toolKind: citation.toolKind,
        level: 'review_candidate',
        approved: 0,
        refused: 0,
        citations: [],
      };
      claimsByKey.set(claimKey, claim);
    }
    claim[verdict] += 1;
    claim.citations.push(citation);
  }

  // Admissions the trail never resolved to an outcome are silence, not evidence.
  for (const admission of admissions) {
    if (workspaceFilter && admission.workspaceId !== workspaceFilter) continue;
    if (referencedAdmissionIds.has(admission.receiptId)) continue;
    pending.push({
      receiptId: String(admission.receiptId || ''),
      admissionId: String(admission.admissionId || ''),
      workspaceId: admission.workspaceId,
      toolName: firstText([admission.metadata?.toolName], 'unknown'),
      why: 'no outcome receipt was ever recorded; silence is not evidence',
    });
  }

  const claims = [...claimsByKey.values()]
    .map((claim) => {
      const level = claim.citations.some(citation => citation.level === 'canonical_evidence')
        ? 'canonical_evidence'
        : 'review_candidate';
      return {
        ...claim,
        level,
        ladder: evidenceLadderAt(level),
        // Keep the most recent citations when a claim outgrows the cap; the
        // tallies above already counted every verdict.
        citations: claim.citations.slice(-MAX_CITATIONS),
      };
    })
    .sort((left, right) => left.claimKey.localeCompare(right.claimKey));

  return {
    projectionVersion: PROJECTION_VERSION,
    workspaceId: workspaceFilter || null,
    receiptCount: trail.length,
    claims,
    pending,
    skipped,
  };
}

/**
 * Read the outcome trail and return the citations a Dream hypothesis may cite.
 * Never throws: an unavailable trail yields no evidence instead of failing the
 * Dream loop.
 *
 * @param {string} [workspaceId] workspace to project (unscoped when omitted)
 * @param {object} [options]
 * @param {string} [options.path] trail path (defaults to the configured trail)
 * @param {object} [options.environment] environment used for the default path
 * @returns {object[]} at most MAX_CITATIONS citations, oldest first
 */
function gateOutcomeCitations(workspaceId, options = {}) {
  try {
    const { receipts } = readExternalActionReceiptsWithErrors({
      path: options.path,
      environment: options.environment,
    });
    const projection = projectGateOutcomeTrail(receipts, { workspaceId });
    const seen = new Set();
    const citations = [];
    for (const claim of projection.claims) {
      for (const citation of claim.citations) {
        if (seen.has(citation.receiptId)) continue;
        seen.add(citation.receiptId);
        citations.push(citation);
        if (citations.length >= MAX_CITATIONS) return citations;
      }
    }
    return citations;
  } catch (error) {
    return [];
  }
}

module.exports = {
  PROJECTION_VERSION,
  MAX_CITATIONS,
  projectGateOutcomeTrail,
  gateOutcomeCitations,
};
