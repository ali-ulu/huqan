'use strict';

const { normalizeWorkspaceId } = require('./cli-mutation-audit-intent');
const {
  UNCLASSIFIED_SOURCE_CONFIDENCE,
  TRUST_POLICY_UNAVAILABLE_CONFIDENCE,
  admissionRiskFromConfidence,
  buildBackgroundProvenance,
  sponsorBackgroundProvenance,
  provenanceFieldsFrom,
} = require('./background-provenance-projection');

/**
 * K2 (#328, docs/kernel-split-plan.md): admission-gated background edge
 * commit, extracted from Kernel.js as a dependency-injected pure function.
 *
 * FAZ2-PR3 (F-001) behaviour, unchanged:
 *
 * - Builds synthetic provenance describing the background source.
 * - Routes the proposed edge through evaluateLearnAdmission (the same gate
 *   the user-facing learn path uses).
 * - On 'allow': writes the edge with source/provenance metadata and emits
 *   a LEARN audit event tagged background:<source>.
 * - On 'review' or 'reject' (the default for synthetic background
 *   provenance): does NOT write the canonical edge and emits a REVIEW or
 *   REJECT audit event so the attempt is recorded.
 *
 * @param {object} deps
 * @param {function} deps.buildProvenance       (source, workspaceId, extra) => provenance -- defaults to buildBackgroundProvenance
 * @param {function} deps.evaluateLearnAdmission (text, admissionOpts, provenance, workspaceId) => admission|null
 * @param {function} deps.appendAuditEvent      (event, provenance, workspaceId) => audit
 * @param {function} deps.admissionReceiptDetails (admission) => object
 * @param {function} deps.addEdge               (from, to, relation, edgeOptions) => edge
 * @param {string}   [deps.contractVersion]
 * @param {string}   [deps.trustPolicyPath]
 * @returns {function} (from, to, relation, source, opts) => {decision, edge, audit, admission}
 */
function commitBackgroundEdge(deps = {}) {
  const buildProvenance = deps.buildProvenance || buildBackgroundProvenance;
  const evaluateLearnAdmission = deps.evaluateLearnAdmission;
  const appendAuditEvent = deps.appendAuditEvent;
  const admissionReceiptDetails = deps.admissionReceiptDetails;
  const addEdge = deps.addEdge;
  const contractVersion = deps.contractVersion;
  const trustPolicyPath = deps.trustPolicyPath;
  if (typeof evaluateLearnAdmission !== 'function' ||
    typeof appendAuditEvent !== 'function') {
    // Fail-closed: without the admission gate there is no safe write path.
    throw new Error('commitBackgroundEdge requires deps.evaluateLearnAdmission and deps.appendAuditEvent');
  }
  return function commitBackgroundEdge(from, to, relation, source, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId || 'default');
    const provenance = buildProvenance(source, workspaceId, opts.provenanceExtra || {}, {
      contractVersion,
      trustPolicyPath,
    });
    const proposalText = `${from} ${relation} ${to}`;
    const admissionOpts = {
      ...(opts.admissionOpts || {}),
      workspaceId,
      provenanceId: provenance.provenanceId,
      actor: provenance.actor,
      agentId: provenance.actor,
      sourceType: provenance.sourceType,
      sourceRef: provenance.sourceRef,
      admissionReason: `background_${source}_edge_write`,
      admissionContext: {
        ...(opts.admissionOpts && opts.admissionOpts.admissionContext) || {},
        backgroundSource: source,
      },
    };
    const admission = evaluateLearnAdmission(proposalText, admissionOpts, provenance, workspaceId);

    // An operator-directed local bypass is expressed as an explicit
    // admissionOpts.admissionBypassReason on the *calling* opts (e.g. the
    // dream { learnFromDream, admissionOpts } passthrough). In that case
    // _evaluateLearnAdmission honours the bypass and returns null; we turn
    // that null into an allow here so the requested write actually lands.
    // Without this explicit reason, admission stays null and the write is
    // fail-closed (review) below — default behaviour is unchanged and the
    // F-001 guard (no default bypass injection) is preserved.
    const explicitBypassRequested = Boolean(
      opts && opts.admissionOpts &&
      typeof opts.admissionOpts.admissionBypassReason === 'string' &&
      opts.admissionOpts.admissionBypassReason.trim().length > 0,
    );
    const resolvedAdmission = (!admission && explicitBypassRequested)
      ? {
          outcome: 'allow',
          reason: 'local_admission_bypass_requested',
          graphWrite: true,
          workspaceId,
          approvalStatus: 'approved',
          provenanceId: provenance ? provenance.provenanceId : null,
        }
      : admission;

    if (!resolvedAdmission) {
      const audit = appendAuditEvent({
        eventType: 'REVIEW',
        targetType: 'background_edge',
        targetId: `${from}|${relation}|${to}`,
        details: {
          backgroundSource: source,
          reason: 'admission_unavailable',
          from,
          to,
          relation,
        },
      }, provenance, workspaceId);
      return { decision: 'review', edge: null, audit, admission: null };
    }
    if (resolvedAdmission.outcome !== 'allow') {
      const audit = appendAuditEvent({
        eventType: resolvedAdmission.outcome === 'reject' ? 'REJECT' : 'REVIEW',
        targetType: 'background_edge',
        targetId: `${from}|${relation}|${to}`,
        details: {
          backgroundSource: source,
          reason: resolvedAdmission.reason,
          admissionOutcome: resolvedAdmission.outcome,
          approvalStatus: resolvedAdmission.approvalStatus,
          ...(admissionReceiptDetails ? admissionReceiptDetails(resolvedAdmission) : {}),
          from,
          to,
          relation,
        },
      }, provenance, workspaceId);
      return { decision: resolvedAdmission.outcome, edge: null, audit, admission: resolvedAdmission };
    }
    const edgeOptions = {
      ...(opts.edgeOptions || {}),
      workspaceId,
      provenance,
      source: opts.edgeOptions && opts.edgeOptions.source
        ? opts.edgeOptions.source
        : `background:${source}`,
    };
    const edge = addEdge ? addEdge(from, to, relation, edgeOptions) : null;
    const audit = appendAuditEvent({
      eventType: 'LEARN',
      targetType: 'background_edge',
      targetId: edge ? `${edge.from}|${edge.relation}|${edge.to}` : `${from}|${relation}|${to}`,
      details: {
        backgroundSource: source,
        from,
        to,
        relation,
        admissionOutcome: 'allow',
        ...(admissionReceiptDetails ? admissionReceiptDetails(resolvedAdmission) : {}),
      },
    }, provenance, workspaceId);
    return { decision: 'allow', edge, audit, admission: resolvedAdmission };
  };
}

module.exports = {
  UNCLASSIFIED_SOURCE_CONFIDENCE,
  TRUST_POLICY_UNAVAILABLE_CONFIDENCE,
  admissionRiskFromConfidence,
  buildBackgroundProvenance,
  sponsorBackgroundProvenance,
  provenanceFieldsFrom,
  commitBackgroundEdge,
};
