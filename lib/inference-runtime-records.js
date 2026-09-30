'use strict';

const { factKey } = require('./inference-semi-naive-values');
const { buildDerivedRecord } = require('./inference-derived-record');
const { withdrawDependents } = require('./inference-derived-dependency');

function reconcile(records, snapshot, at) {
  let current = records;
  const supports = new Map(snapshot.details.map(detail => [factKey(detail.fact), detail]));
  for (const record of records) {
    if (!['provisional', 'admitted'].includes(record.state)) continue;
    for (const support of record.supports) {
      if (support.derivedRecordId) {
        const parent = current.find(item => item.derivationId === support.derivedRecordId);
        if (!parent || !['provisional', 'admitted'].includes(parent.state)) {
          current = withdrawDependents(current, { derivationId: support.derivedRecordId }, { at, reason: 'derived_support_unavailable' }).records;
        }
        continue;
      }
      const active = supports.get(support.factKey);
      if (!active || JSON.stringify(active.provenanceRefs) !== JSON.stringify(support.provenanceRefs)
        || JSON.stringify(active.sourceRefs) !== JSON.stringify(support.sourceRefs)) {
        current = withdrawDependents(current, { fact: support.fact }, { at, reason: 'support_removed_superseded_or_contested' }).records;
      }
    }
  }
  return current;
}
function buildRecords(evaluation, snapshot, ruleSnapshotId, workspaceId, at) {
  const details = new Map(snapshot.details.map(detail => [factKey(detail.fact), detail]));
  const records = [];
  const candidates = [...evaluation.derivedCandidates].sort((a, b) => a.round - b.round || factKey(a.fact).localeCompare(factKey(b.fact)));
  for (const candidate of candidates) {
    const record = buildDerivedRecord(candidate, {
      workspaceId, derivedAt: at, graphSnapshotId: snapshot.graphSnapshotId, ruleSnapshotId,
      supportDetails: candidate.directSupports.map(fact => details.get(factKey(fact))),
      allowProvisionalSupports: true,
    });
    records.push(record);
    details.set(record.factKey, {
      fact: record.fact, derivedRecordId: record.derivationId, state: 'provisional',
      provenanceRefs: [record.derivationId], transitiveProvenanceRefs: record.transitiveProvenanceRefs,
      transitiveSourceRefs: record.transitiveSourceRefs,
    });
  }
  return records;
}
module.exports = { reconcile, buildRecords };
