'use strict';

// #2505 K, first slice: what an agent can reach and do, and its measured
// blast radius, compiled from already-recorded data into one format.
//
// Inputs are the normalized capability card (authority) and the recorded
// session impact summary (measurement). Both vocabularies are reused
// verbatim: capabilities, taskScope and expiry spell exactly as the card
// carries them, and the blast radius and bypass signals spell exactly as the
// session summary reports them -- including its nulls. A null is propagated,
// never read as zero.
//
// Recorded only (`enforced: false`). No thresholds, no decisions, no clock:
// the same inputs always yield the same report, so it is safe to compare,
// store and publish later. Publishing through the trust protocol is an
// explicitly deferred slice; so is any enforcement use of these numbers.
//
// No production caller yet: the publisher lands with the trust-protocol
// publish slice, which is why lib/module-reachability.js carries this file
// in NOT_YET_WIRED with that reason.

const CAPABILITY_REPORT_VERSION = 'huqan-capability-report-v1';
const CAPABILITY_PROJECTION_VERSION = 'huqan-capability-projection-v1';

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildAgentCapabilityReport({ card = null, sessionImpact = null } = {}) {
  const reasons = [];
  const cardObj = card && typeof card === 'object' && !Array.isArray(card) ? card : null;
  if (!cardObj) reasons.push('no capability card supplied');
  const impact = sessionImpact && typeof sessionImpact === 'object' && !Array.isArray(sessionImpact)
    ? sessionImpact
    : null;
  if (!impact) reasons.push('no session impact summary supplied');

  const capabilities = cardObj && Array.isArray(cardObj.capabilities)
    ? Object.freeze(cardObj.capabilities.filter((entry) => typeof entry === 'string').map((entry) => entry))
    : null;
  if (cardObj && capabilities !== null && capabilities.length === 0 && cardObj.capabilities.length !== 0) {
    reasons.push('capability card carries no readable capabilities');
  }

  const blastRadius = impact
    ? Object.freeze({
      total: num(impact.recordedScoreTotal),
      max: num(impact.maxScore),
      scoredActions: num(impact.scoredActions),
      unscoredActions: num(impact.unscoredActions),
    })
    : null;
  const bypassSignals = impact
    ? Object.freeze({
      refusedActions: num(impact.refusedActions),
      retriedRefusedActions: num(impact.retriedRefusedActions),
      sandboxEscapeAttempts: num(impact.sandboxEscapeAttempts),
    })
    : null;

  const agentRef = cardObj && (text(cardObj.workspaceId) || text(cardObj.agentId))
    ? `agent:${text(cardObj.workspaceId) || 'default'}:${text(cardObj.agentId) || 'unknown'}`
    : null;
  if (cardObj && !agentRef) reasons.push('capability card names no workspace or agent');

  return Object.freeze({
    version: CAPABILITY_REPORT_VERSION,
    agentRef,
    capabilities,
    taskScope: cardObj && cardObj.taskScope !== undefined ? cardObj.taskScope : null,
    identityExpiresAt: cardObj ? (text(cardObj.expiresAt) || null) : null,
    measuredBlastRadius: blastRadius,
    bypassSignals,
    status: reasons.length ? 'partial' : 'computed',
    reasons: Object.freeze(reasons),
    enforced: false,
  });
}

/**
 * #2505 K: the public projection of a capability report. Redaction is
 * subtractive and total: agent identity, task scope and expiry never leave
 * this function, so there is no allowlist to drift. Raw task IDs and target
 * names cannot appear because the fields that carry them are dropped, not
 * filtered. Measurement counts and the capability vocabulary ride through;
 * binding the projection to the card hash needs the card itself and stays
 * with the publisher slice.
 */
function projectPublicCapabilityReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new TypeError('report must be a capability report');
  }
  if (report.version !== CAPABILITY_REPORT_VERSION) {
    throw new TypeError(`report version must be ${CAPABILITY_REPORT_VERSION}`);
  }
  const reasons = ['agent identity, task scope and expiry are withheld from the public projection'];
  if (report.taskScope !== undefined && report.taskScope !== null) {
    reasons.push('a task scope was present and withheld');
  }
  return Object.freeze({
    version: CAPABILITY_PROJECTION_VERSION,
    capabilities: Array.isArray(report.capabilities)
      ? Object.freeze(report.capabilities.filter((entry) => typeof entry === 'string'))
      : null,
    measuredBlastRadius: report.measuredBlastRadius && typeof report.measuredBlastRadius === 'object'
      ? Object.freeze({ ...report.measuredBlastRadius })
      : null,
    bypassSignals: report.bypassSignals && typeof report.bypassSignals === 'object'
      ? Object.freeze({ ...report.bypassSignals })
      : null,
    status: typeof report.status === 'string' ? report.status : 'unknown',
    reasons: Object.freeze(reasons),
    enforced: false,
  });
}

module.exports = {
  CAPABILITY_REPORT_VERSION,
  CAPABILITY_PROJECTION_VERSION,
  buildAgentCapabilityReport,
  projectPublicCapabilityReport,
};
