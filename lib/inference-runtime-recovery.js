'use strict';

const { transitionDerivedRecord } = require('./inference-derived-record');

// The canonical candidate transaction and the runtime-state transaction cannot
// nest. Recover their durable link instead of trusting a returned receipt id.
function recoverAdmissions(graph, records, workspaceId, at) {
  const pending = records.filter(record => record.state === 'provisional');
  if (!pending.length) return records;
  const byCandidate = new Map();
  for (const record of pending) byCandidate.set(`cand_inference_${record.derivationId.replace(/^prov_/, '')}`, record);
  const recovered = new Map();
  for (const row of graph.getCommittedMutationResultsByPrefix('auto-mut-candidate-')) {
    const candidate = row.result?.candidate;
    const record = byCandidate.get(candidate?.candidateId);
    const receipt = row.receipt;
    if (!record || candidate.status !== 'accepted' || candidate.workspaceId !== workspaceId) continue;
    if (!receipt || receipt.workspaceId !== workspaceId || receipt.canonicalPayload?.provenanceId !== record.derivationId
      || receipt.canonicalPayload?.decision !== 'allow' || receipt.canonicalPayload?.status !== 'admitted') continue;
    const edge = row.result?.edge;
    if (!edge || edge.provenance?.provenanceId !== record.derivationId || edge.from !== record.fact.args[0]?.value
      || edge.to !== record.fact.args[1]?.value || edge.relation !== record.fact.predicate) continue;
    recovered.set(record.derivationId, transitionDerivedRecord(record, 'admitted', {
      at, reason: 'canonical_admission_recovered', receiptId: receipt.receiptId,
      candidateId: candidate.candidateId, operationId: row.operationId,
    }));
  }
  return records.map(record => recovered.get(record.derivationId) || record);
}
module.exports = { recoverAdmissions };
