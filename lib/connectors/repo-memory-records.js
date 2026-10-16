const { recordIngestError } = require('../bounded-ingest-errors');

function nowIso() {
  return new Date().toISOString();
}

const INGEST_STATE_KEY = '_repoMemoryIngestState';

function ensureCompanyState(kernel) {
  if (!kernel[INGEST_STATE_KEY]) {
    kernel[INGEST_STATE_KEY] = {
      bySource: { repo: 0, markdown: 0, json: 0, yaml: 0, 'git-log': 0, pdf: 0, http: 0, manual: 0 },
      lastIngestAt: null,
      ingestErrors: [],
    };
  }
  return kernel[INGEST_STATE_KEY];
}

function trackIngestSuccess(kernel, sourceType, amount) {
  const state = ensureCompanyState(kernel);
  if (!(sourceType in state.bySource)) state.bySource[sourceType] = 0;
  state.bySource[sourceType] += Math.max(0, Number(amount || 0));
  state.lastIngestAt = nowIso();
}

function trackIngestError(kernel, sourceType, message) {
  const state = ensureCompanyState(kernel);
  recordIngestError(state, sourceType, message, nowIso());
  state.lastIngestAt = nowIso();
}

function addCompanyEdge(kernel, fromId, toId, relation, opts = {}) {
  const provenance = opts.provenance && typeof opts.provenance === 'object' ? opts.provenance : null;
  const workspaceId = opts.workspaceId || provenance?.workspaceId || 'default';
  const fromProvenance = opts.fromProvenance && typeof opts.fromProvenance === 'object' ? opts.fromProvenance : provenance;
  const toProvenance = opts.toProvenance && typeof opts.toProvenance === 'object' ? opts.toProvenance : provenance;
  const fromResult = kernel.proposeNode(fromId, opts.fromLabel || fromId, fromProvenance, { workspaceId });
  const toResult = kernel.proposeNode(toId, opts.toLabel || toId, toProvenance, { workspaceId });
  const edgeResult = kernel.proposeEdge(fromId, toId, relation, {
    source: opts.source || 'repo',
    sourceRef: opts.sourceRef || provenance?.sourceRef || '',
    sessionId: opts.sessionId || '',
    sourceType: opts.sourceType || provenance?.sourceType || 'repo',
    companyMode: true,
    evidenceType: opts.evidenceType || 'docs',
    evidence: Array.isArray(opts.evidence) ? opts.evidence : [],
    confidence: typeof opts.confidence === 'number' ? opts.confidence : 0.75,
    createdAt: opts.createdAt || '',
    provenance,
    workspaceId,
  });
  return { fromResult, toResult, edgeResult, edge: edgeResult?.edge || null };
}

function buildGraphAdmissionRecord({
  kind,
  outcome = 'admitted',
  targetType,
  targetId,
  provenance = null,
  proposal = null,
  workspaceId = 'default',
  details = {},
}) {
  const decision = proposal?.decision || '';
  const graphWrite = Boolean(proposal?.node || proposal?.edge);
  const resolvedOutcome = decision === 'allow'
    ? (graphWrite ? 'admitted' : 'skipped')
    : decision === 'reject'
      ? 'rejected'
      : decision === 'review'
        ? 'candidate'
        : outcome;
  return {
    kind,
    outcome: resolvedOutcome,
    targetType,
    targetId,
    workspaceId,
    sourceType: provenance?.sourceType || '',
    sourceRef: provenance?.sourceRef || '',
    actor: provenance?.actor || '',
    provenanceId: provenance?.provenanceId || '',
    trustPolicyVersion: provenance?.trustPolicyVersion || '',
    graphWrite,
    provenance: provenance || null,
    decision: decision || undefined,
    reason: proposal?.admission?.reason || undefined,
    receiptId: proposal?.admission?.receiptId || undefined,
    auditId: proposal?.audit?.auditId || undefined,
    ...details,
  };
}

function summarizeGraphAdmissions(entries = []) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const counts = list.reduce((acc, entry) => {
    const key = entry.outcome || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const outcome = list.length === 0
    ? 'skipped'
    : (counts.rejected > 0 ? 'rejected'
      : counts.candidate > 0 ? 'candidate'
        : counts.admitted > 0 ? 'admitted'
          : counts.skipped > 0 ? 'skipped'
            : 'unknown');
  return {
    outcome,
    counts,
    total: list.length,
    entries: list,
  };
}

function buildSectionNodeId(prefix, sectionTitle) {
  return `section:${prefix}:${sectionTitle}`;
}

/**
 * The three admission records one proposed edge produces: the repeated
 * proposal of its parent node, the child node, and the edge itself.
 */
function pushEdgeAdmissions(admissions, proposal, edge) {
  const { fromId, toId, relation, fromProvenance, toProvenance, workspaceId } = edge;
  admissions.push(buildGraphAdmissionRecord({
    kind: 'node',
    targetType: 'graph_node',
    targetId: fromId,
    provenance: fromProvenance,
    proposal: proposal.fromResult,
    workspaceId,
    details: { repeatedProposal: true, childId: toId },
  }));
  admissions.push(buildGraphAdmissionRecord({
    kind: 'node',
    targetType: 'graph_node',
    targetId: toId,
    provenance: toProvenance,
    proposal: proposal.toResult,
    workspaceId,
    details: { parentId: fromId, ...edge.childDetails },
  }));
  admissions.push(buildGraphAdmissionRecord({
    kind: 'edge',
    targetType: 'graph_edge',
    targetId: `${fromId}|${relation}|${toId}`,
    provenance: toProvenance,
    proposal: proposal.edgeResult,
    workspaceId,
    details: { relation, sourceRef: toProvenance.sourceRef },
  }));
}

module.exports = {
  nowIso,
  ensureCompanyState,
  trackIngestSuccess,
  trackIngestError,
  addCompanyEdge,
  buildGraphAdmissionRecord,
  summarizeGraphAdmissions,
  buildSectionNodeId,
  pushEdgeAdmissions,
};
