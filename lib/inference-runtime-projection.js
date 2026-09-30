'use strict';

// Projection changes reuse Graph's downgrade and contested-read authorities.
// Immutable admission receipts and the former edge are kept in the journal.
function downgradeWithdrawnEdges(graph, records, at) {
  const changes = [];
  for (const record of records) {
    if (!record.trustReceiptId || !['withdrawn', 'contradicted', 'superseded'].includes(record.state) || record.fact.args.length !== 2) continue;
    const [fromId, toId] = record.fact.args.map(term => term.value);
    const edge = graph.getEdge(fromId, toId, record.fact.predicate, record.workspaceId);
    // Never downgrade a later independent replacement of the same triple.
    if (!edge || edge.provenance?.provenanceId !== record.derivationId) continue;
    if (edge.celiski === 'inference_support_withdrawn' && edge.confidence === 0) continue;
    graph.downgradeEdge({ fromId, toId, relation: record.fact.predicate, workspaceId: record.workspaceId,
      weight: 0, confidence: 0, marker: 'inference_support_withdrawn' });
    graph.addCandidateClaim({
      candidateId: `cand_withdrawal_${record.derivationId}`, workspaceId: record.workspaceId,
      claim: 'The supporting inference is no longer admissible.',
      proposedEdge: { from: fromId, to: toId, relation: record.fact.predicate },
      conflict: { conflict: true, type: 'inference_support_withdrawn', reason: record.history.at(-1).reason },
      recommendation: 'flag', status: 'pending', createdAt: at,
    });
    changes.push({ derivationId: record.derivationId, receiptId: record.trustReceiptId, previousEdge: edge });
  }
  return changes;
}
module.exports = { downgradeWithdrawnEdges };
