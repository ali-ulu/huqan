'use strict';

const { recordPrediction, recordOutcome, readPredictionPairs } = require('./prediction-outcome-pairs');
const { calibrateRuleBeliefFromStore, reviseDerivedConclusionBeliefs } = require('./inference-belief-revision');
const { transitionDerivedRecord } = require('./inference-derived-record');
const { withdrawDependents } = require('./inference-derived-dependency');
const { detectClaimConflict } = require('./conflict-detector');
const { digest } = require('./inference-runtime-snapshot');

function actionClass(workspaceId, ruleId) { return `inference-rule:${digest([workspaceId, ruleId]).slice(0, 40)}`; }
function decisionId(record) {
  return `inference:${digest([record.workspaceId, record.ruleId, record.factKey, record.transitiveProvenanceRefs])}`;
}
function predict(graph, records, at) {
  for (const record of records) {
    recordPrediction(graph, { decisionId: decisionId(record), unknown: 'rule_belief_not_outcome_probability', actionClass: actionClass(record.workspaceId, record.ruleId), at });
  }
}
function observe(kernel, records, snapshot, previousEffects, at) {
  const pairs = readPredictionPairs(kernel.graph);
  const effects = new Map(previousEffects.map(effect => [effect.decisionId, effect]));
  const facts = new Set(snapshot.details.map(detail => JSON.stringify([detail.fact.predicate, ...detail.fact.args.map(term => term.value)])));
  // Conflict detection reuses the existing detector, but only with independently
  // sourced, currently active snapshot edges. Provisional conclusions are absent.
  const graph = { getEdgesBetween: (from, to) => snapshot.details
    .filter(detail => detail.fact.args[0].value === from && detail.fact.args[1].value === to)
    .map(detail => ({ from, to, relation: detail.fact.predicate, provenance: { provenanceId: detail.provenanceRefs[0] } })) };
  for (const record of records) {
    const id = decisionId(record);
    if (!pairs[id] || effects.has(id) || record.fact.args.length !== 2) continue;
    const conflict = detectClaimConflict(graph, { workspaceId: record.workspaceId, proposedEdge: {
      from: record.fact.args[0].value, to: record.fact.args[1].value, relation: record.fact.predicate,
    } });
    const outcome = conflict.conflict ? 'contradiction' : facts.has(record.factKey) ? 'confirmed' : null;
    if (!outcome) continue;
    // Existing reported/censored outcomes cannot be relabelled as observations.
    if (pairs[id].outcome && pairs[id].outcome.state !== outcome) continue;
    if (!pairs[id].outcome) recordOutcome(kernel.graph, { decisionId: id, outcome, idempotencyKey: id, at });
    effects.set(id, { decisionId: id, kind: 'observed', graphSnapshotId: snapshot.graphSnapshotId, outcome, at });
  }
  return [...effects.values()];
}
function calibrate(graph, records, input, previousBeliefs, previousDerived, effects, workspaceId, at) {
  const { ruleId, declaredConfidence } = input;
  if (!records.some(record => record.ruleId === ruleId)) throw new TypeError('unknown rule in workspace');
  const previous = previousBeliefs.find(belief => belief.ruleId === ruleId) || null;
  if (previous && previous.declaredConfidence !== declaredConfidence) throw new TypeError('declared confidence is immutable for an existing rule');
  const belief = calibrateRuleBeliefFromStore(graph, {
    ruleId, declaredConfidence, previous, effectEvidence: effects, at,
  }, { actionClass: actionClass(workspaceId, ruleId), allowLoosening: false });
  if (belief.status === 'invalid') throw new TypeError(belief.reason);
  const revised = reviseDerivedConclusionBeliefs(records, belief, {
    at, previousByDerivationId: Object.fromEntries(previousDerived.map(item => [item.derivationId, item])),
  });
  let next = records;
  if (['degraded', 'defeated'].includes(belief.status)) {
    for (const selected of records.filter(item => item.ruleId === ruleId && ['provisional', 'admitted'].includes(item.state))) {
      const record = next.find(item => item.derivationId === selected.derivationId);
      if (!record || !['provisional', 'admitted'].includes(record.state)) continue;
      next = next.map(item => item.derivationId === record.derivationId
        ? transitionDerivedRecord(item, 'withdrawn', { at, reason: belief.reason }) : item);
      next = withdrawDependents(next, { derivationId: record.derivationId }, { at, reason: belief.reason }).records;
    }
  }
  const revisedIds = new Set(revised.map(item => item.derivationId));
  return {
    records: next,
    beliefs: [...previousBeliefs.filter(item => item.ruleId !== ruleId), belief],
    derivedBeliefs: [...previousDerived.filter(item => !revisedIds.has(item.derivationId)), ...revised],
  };
}
function ruleBlocked(beliefs, id) {
  const belief = beliefs.find(item => item.ruleId === id);
  return Boolean(belief && (belief.systemConfidence < belief.declaredConfidence || ['degraded', 'defeated'].includes(belief.status)));
}
module.exports = { predict, observe, calibrate, ruleBlocked, decisionId };
