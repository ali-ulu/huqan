'use strict';

const { evaluateSemiNaive } = require('./inference-semi-naive');
const { proveBackward } = require('./inference-backward');
const { abduct } = require('./inference-abduction');
const { transitionDerivedRecord } = require('./inference-derived-record');
const { admitDerivedRecord } = require('./inference-derived-admission');
const { boundedLimits, snapshotGraph, snapshotRules } = require('./inference-runtime-snapshot');
const { readRuns, latestRecords, commitRun } = require('./inference-runtime-store');
const { reconcile, buildRecords } = require('./inference-runtime-records');
const { predict, observe, calibrate, ruleBlocked } = require('./inference-runtime-beliefs');
const { recoverAdmissions } = require('./inference-runtime-recovery');

function admit(kernel, records, input, at, beliefs) {
  let record = records.find(item => item.derivationId === input.derivationId);
  if (!record) throw new TypeError('unknown derivation in workspace');
  if (record.state !== 'provisional') return { status: 'held', reason: `derived_state_${record.state}`, records };
  if (record.fact.args.length !== 2) return { status: 'held', reason: 'binary_ground_fact_required', records };
  if (record.supports.some(support => support.derivedRecordId && records.find(item => item.derivationId === support.derivedRecordId)?.state !== 'admitted')) {
    return { status: 'held', reason: 'support_not_admitted', records };
  }
  const belief = beliefs.find(item => item.ruleId === record.ruleId);
  if (!belief || belief.status !== 'calibrated' || ruleBlocked(beliefs, record.ruleId)) return { status: 'held', reason: 'rule_belief_not_admissible', records };
  const verification = kernel.verify(`${record.fact.args[0].value} ${record.fact.predicate} ${record.fact.args[1].value}`, { workspaceId: record.workspaceId });
  const status = verification?.data?.status;
  if (status !== 'verified') {
    if (status === 'contradicted') record = transitionDerivedRecord(record, 'contradicted', { at, reason: 'verification_contradicted' });
    return { status: 'held', reason: 'verification_not_verified', records: records.map(item => item.derivationId === record.derivationId ? record : item) };
  }
  const exactEvidence = verification.evidence?.some(item => item.edges?.some(edge =>
    edge.from === record.fact.args[0].value && edge.to === record.fact.args[1].value && edge.relation === record.fact.predicate));
  if (!exactEvidence) return { status: 'held', reason: 'verification_evidence_mismatch', records };
  const ready = { ...record, supports: record.supports.map(support => support.derivedRecordId ? { ...support, state: 'admitted' } : support) };
  const result = admitDerivedRecord(ready, {
    verifyDerived: () => ({ status }), ingestCandidateClaim: kernel.ingestCandidateClaim.bind(kernel),
  }, { at, requireCommittedReceipt: true });
  return { status: result.status, reason: result.reason, records: records.map(item => item.derivationId === record.derivationId ? result.record : item) };
}
function runInference(kernel, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('inference request must be an object');
  const allowed = new Set(['action', 'workspaceId', 'rules', 'limits', 'query', 'ruleId', 'declaredConfidence', 'derivationId']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError('unsupported inference input field');
  const workspaceId = input.workspaceId === undefined ? 'default' : input.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId !== workspaceId.trim()) throw new TypeError('valid workspaceId required');
  const action = input.action || 'evaluate';
  if (!['evaluate', 'query', 'abduce', 'admit', 'reconcile', 'history', 'observe', 'calibrate'].includes(action)) throw new TypeError('unknown inference action');
  const at = new Date().toISOString();
  const runs = readRuns(kernel.graph, workspaceId);
  if (action === 'history') return { runs };
  const priorState = runs.at(-1) || {};
  const beliefs = priorState.beliefs || [];
  const derivedBeliefs = priorState.derivedBeliefs || [];
  const effects = priorState.effects || [];
  const snapshot = snapshotGraph(kernel, workspaceId);
  const records = reconcile(recoverAdmissions(kernel.graph, latestRecords(runs), workspaceId, at), snapshot, at);
  const revision = runs.at(-1)?.revision || 0;
  const commit = value => commitRun(kernel.graph, workspaceId, revision, { action, at, beliefs, derivedBeliefs, effects, ...value });
  if (action === 'reconcile') return commit({ records });
  if (action === 'observe') return commit({ records, snapshot, effects: observe(kernel, records, snapshot, effects, at) });
  if (action === 'calibrate') return commit(calibrate(kernel.graph, records, input, beliefs, derivedBeliefs, effects, workspaceId, at));
  if (action === 'admit') {
    const result = admit(kernel, records, input, at, beliefs);
    return commit({ ...result, records: reconcile(result.records, snapshot, at) });
  }
  const { rules, ruleSnapshotId } = snapshotRules(input.rules);
  for (const rule of rules) {
    const previous = runs.flatMap(run => run.rules || []).find(item => item.id === rule.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(rule)) throw new TypeError('rule id cannot be reused with different content');
  }
  const eligibleRules = rules.filter(rule => !ruleBlocked(beliefs, rule.id));
  const limits = boundedLimits(input.limits);
  if (action === 'query') return { action, snapshot, rules, limits, result: proveBackward(input.query, eligibleRules, snapshot.facts, limits), authority: 'provisional' };
  if (action === 'abduce') return { action, snapshot, rules, limits, result: abduct(input.query, eligibleRules, snapshot.facts, limits), authority: 'proposal_only' };
  const evaluation = evaluateSemiNaive(eligibleRules, snapshot.facts, limits);
  const derived = buildRecords(evaluation, snapshot, ruleSnapshotId, workspaceId, at);
  const previous = new Map(records.map(record => [record.derivationId, record]));
  for (const record of derived) if (!previous.has(record.derivationId)) previous.set(record.derivationId, record);
  predict(kernel.graph, derived, at);
  return commit({ snapshot, rules, eligibleRules, ruleSnapshotId, limits, evaluation, records: [...previous.values()] });
}
module.exports = { runInference };
