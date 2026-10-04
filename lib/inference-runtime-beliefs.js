'use strict';

const { recordPrediction, recordOutcome, readPredictionPairs } = require('./prediction-outcome-pairs');
const {
  COUNTER_EVIDENCE_KIND,
  calibrateRuleBeliefFromStore,
  reviseDerivedConclusionBeliefs,
  reconcileDerivedConclusionBeliefs,
} = require('./inference-belief-revision');
const { transitionDerivedRecord } = require('./inference-derived-record');
const { withdrawDependents } = require('./inference-derived-dependency');
const { detectClaimConflict } = require('./conflict-detector');
const { digest } = require('./inference-runtime-snapshot');

function actionClass(workspaceId, ruleId) { return `inference-rule:${digest([workspaceId, ruleId]).slice(0, 40)}`; }
function decisionId(record) {
  return `inference:${digest([record.workspaceId, record.ruleId, record.factKey, record.transitiveProvenanceRefs])}`;
}
function sourceEventRefs(record) {
  const provenance = Array.isArray(record.transitiveProvenanceRefs)
    ? record.transitiveProvenanceRefs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => ref.trim())
    : [];
  if (provenance.length > 0) return [...new Set(provenance)].sort();
  const sources = Array.isArray(record.transitiveSourceRefs)
    ? record.transitiveSourceRefs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => `source:${ref.trim()}`)
    : [];
  return sources.length > 0 ? [...new Set(sources)].sort() : [`derivation:${record.derivationId}`];
}
function effectsWithSourceIdentity(records, effects) {
  const refsByDecision = new Map(records.map((record) => [decisionId(record), sourceEventRefs(record)]));
  return effects.map((effect) => {
    if (Array.isArray(effect.sourceEventRefs) && effect.sourceEventRefs.length > 0) return effect;
    const refs = refsByDecision.get(effect.decisionId);
    return refs ? { ...effect, sourceEventRefs: refs } : effect;
  });
}
function collectSupportInvalidationEvidence(records, previous = []) {
  const byId = new Map(previous.map((entry) => [entry.evidenceId, entry]));
  for (const record of records) {
    if (record.state !== 'withdrawn' || !Array.isArray(record.history) || record.history.length === 0) continue;
    const event = record.history[record.history.length - 1];
    if (!['support_removed_superseded_or_contested', 'derived_support_unavailable'].includes(event.reason)) continue;
    const id = decisionId(record);
    const evidenceId = `${COUNTER_EVIDENCE_KIND.SUPPORT_INVALIDATION}:${id}:${event.supportRef || record.derivationId}`;
    if (byId.has(evidenceId)) continue;
    byId.set(evidenceId, Object.freeze({
      evidenceId,
      ruleId: record.ruleId,
      decisionId: id,
      kind: COUNTER_EVIDENCE_KIND.SUPPORT_INVALIDATION,
      sourceEventRefs: Object.freeze(sourceEventRefs(record)),
      at: event.at,
    }));
  }
  return Object.freeze([...byId.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
}
function reconcileDerivedBeliefs(records, previousDerived, at) {
  return reconcileDerivedConclusionBeliefs(records, previousDerived, { at });
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
    effects.set(id, {
      decisionId: id,
      kind: 'observed',
      sourceEventRefs: sourceEventRefs(record),
      graphSnapshotId: snapshot.graphSnapshotId,
      outcome,
      at,
    });
  }
  return [...effects.values()];
}
function calibrate(graph, records, input, previousBeliefs, previousDerived, effects, counterEvidence, workspaceId, at) {
  const { ruleId, declaredConfidence } = input;
  if (!records.some(record => record.ruleId === ruleId)) throw new TypeError('unknown rule in workspace');
  const previous = previousBeliefs.find(belief => belief.ruleId === ruleId) || null;
  if (previous && previous.declaredConfidence !== declaredConfidence) throw new TypeError('declared confidence is immutable for an existing rule');
  const belief = calibrateRuleBeliefFromStore(graph, {
    ruleId,
    declaredConfidence,
    previous,
    effectEvidence: effectsWithSourceIdentity(records, effects),
    counterEvidence,
    at,
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
module.exports = {
  predict,
  observe,
  calibrate,
  ruleBlocked,
  decisionId,
  collectSupportInvalidationEvidence,
  reconcileDerivedBeliefs,
};
