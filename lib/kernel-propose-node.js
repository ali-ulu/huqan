'use strict';

const { normalizeWorkspaceId } = require('./cli-mutation-audit-intent');
const { buildBackgroundProvenance, sponsorBackgroundProvenance } = require('./background-provenance');

/**
 * F-003: Plugin-facing admission-gated node write.
 *
 * Moved verbatim from Kernel.proposeNode (#2127). Collaborators arrive as
 * an explicit object so this module never reaches into kernel internals.
 * The admission gate stays fail-closed: unavailable admission audits
 * REVIEW, a refusing admission audits REJECT/REVIEW, and only an allowed
 * admission reaches the graph write.
 */
function runProposeNode(collaborators, id, label, provenance, opts = {}) {
  const {
    graph,
    contractVersion,
    trustPolicyPath,
    evaluateLearnAdmission,
    appendAuditEvent,
    admissionReceiptDetails,
  } = collaborators;
  if (!graph || typeof graph.addNode !== 'function') {
    return { decision: 'review', node: null, audit: null, admission: null };
  }

  const workspaceId = normalizeWorkspaceId(opts.workspaceId || provenance?.workspaceId || 'default');
  const pluginProvenance = provenance && typeof provenance === 'object'
    ? sponsorBackgroundProvenance(provenance, 'plugin', workspaceId)
    : buildBackgroundProvenance('plugin', workspaceId, {
      sourceType: opts.sourceType || 'plugin',
      sourceRef: opts.sourceRef || '',
      actor: opts.actor || opts.sessionId || 'plugin',
    }, {
      contractVersion: contractVersion,
      trustPolicyPath: trustPolicyPath,
    });
  const proposalText = `${id} ${label || id}`;
  const admissionOpts = {
    workspaceId,
    provenanceId: pluginProvenance.provenanceId,
    actor: pluginProvenance.actor,
    agentId: opts.sessionId || pluginProvenance.actor,
    sourceType: pluginProvenance.sourceType,
    sourceRef: pluginProvenance.sourceRef,
    approvalRequired: false,
    admissionReason: 'background_plugin_node_write',
    admissionContext: {
      backgroundSource: 'plugin',
      nodeId: id,
    },
  };
  const admission = evaluateLearnAdmission(proposalText, admissionOpts, pluginProvenance, workspaceId);

  if (!admission) {
    const audit = appendAuditEvent({
      eventType: 'REVIEW',
      targetType: 'background_node',
      targetId: id,
      details: {
        backgroundSource: 'plugin',
        reason: 'admission_unavailable',
        nodeId: id,
        label: label || id,
      },
    }, pluginProvenance, workspaceId);
    return { decision: 'review', node: null, audit, admission: null };
  }

  if (admission.outcome !== 'allow') {
    const audit = appendAuditEvent({
      eventType: admission.outcome === 'reject' ? 'REJECT' : 'REVIEW',
      targetType: 'background_node',
      targetId: id,
      details: {
        backgroundSource: 'plugin',
        reason: admission.reason,
        admissionOutcome: admission.outcome,
        approvalStatus: admission.approvalStatus,
        ...admissionReceiptDetails(admission),
        nodeId: id,
        label: label || id,
      },
    }, pluginProvenance, workspaceId);
    return { decision: admission.outcome, node: null, audit, admission };
  }

  const node = graph.addNode(id, label, pluginProvenance, { ...opts, workspaceId });
  const audit = appendAuditEvent({
    eventType: 'LEARN',
    targetType: 'background_node',
    targetId: id,
    details: {
      backgroundSource: 'plugin',
      nodeId: id,
      label: label || id,
      admissionOutcome: 'allow',
      ...admissionReceiptDetails(admission),
    },
  }, pluginProvenance, workspaceId);
  return { decision: 'allow', node, audit, admission };
}

module.exports = { runProposeNode };
