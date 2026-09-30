'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');
const CLI = require('../cli');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { atom, variable, constant, createRule } = require('../lib/inference-rule-ir');
const { evaluateSemiNaive } = require('../lib/inference-semi-naive');
const { factKey } = require('../lib/inference-semi-naive-values');

function rule(id, head, body) {
  const args = [variable('X'), variable('Y')];
  return createRule({ id, head: atom(head, args), body: [atom(body, args)] });
}
function fixture(t) {
  const options = isolatedKernelOptions('inference-runtime', { loadPlugins: false, memoryStoreUseSQLite: false });
  const kernel = new Kernel(options);
  const cli = new CLI({ kernelInstance: kernel });
  const provenance = { provenanceId: 'prov-source', sourceType: 'document', sourceRef: 'doc:1', actor: 'operator', timestamp: '2026-09-30T00:00:00Z', workspaceId: 'default' };
  kernel.graph.addNode('Alice', 'Alice', provenance);
  kernel.graph.addNode('Bob', 'Bob', provenance);
  kernel.graph.addEdge('Alice', 'Bob', 'knows', { provenance, confidence: 0.9 });
  t.after(() => { cli.agent?.storage?.close?.(); kernel.graph.close(); kernel.memory?.close?.(); });
  const run = input => {
    const parsed = cli.parse(`inference ${JSON.stringify(input)}`);
    assert.equal(parsed.command, 'inference');
    return JSON.parse(cli.execute(parsed.command, parsed.args));
  };
  return { kernel, cli, run, options };
}

test('production CLI derives an unstored variable fact with replayable snapshot and provenance', t => {
  const { kernel, run } = fixture(t);
  const result = run({ rules: [rule('r1', 'connected', 'knows')] });
  assert.equal(result.evaluation.status, 'complete');
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.state, 'provisional');
  assert.equal(record.ruleId, 'r1');
  assert.deepEqual(record.transitiveProvenanceRefs, ['prov-source']);
  assert.equal(record.fact.args[0].value, 'Alice');
  assert.deepEqual(evaluateSemiNaive(result.rules, result.snapshot.facts, result.limits).derivedCandidates, result.evaluation.derivedCandidates);
  assert.equal(kernel.graph.getAllEdges().length, 1);
  assert.equal(run({ action: 'history' }).runs.length, 1);
});

test('multi-round proofs remain provisional and dependent admission is held', t => {
  const { run } = fixture(t);
  const result = run({ rules: [rule('r1', 'connected', 'knows'), rule('r2', 'reachable', 'connected')] });
  assert.equal(result.records.length, 2);
  const last = result.records.find(item => item.ruleId === 'r2');
  assert.equal(last.supports[0].state, 'provisional');
  assert.ok(last.supports[0].derivedRecordId);
  assert.ok(last.transitiveProvenanceRefs.includes('prov-source'));
  assert.equal(run({ action: 'admit', derivationId: last.derivationId }).reason, 'support_not_admitted');
});

test('changed support provenance withdraws descendants and preserves prior history', t => {
  const { kernel, run } = fixture(t);
  const result = run({ rules: [rule('r1', 'connected', 'knows'), rule('r2', 'reachable', 'connected')] });
  kernel.graph.addEdge('Alice', 'Bob', 'knows', { provenance: { provenanceId: 'replacement', sourceType: 'document', sourceRef: 'doc:2' } });
  const updated = run({ action: 'reconcile' });
  assert.ok(updated.records.every(record => record.state === 'withdrawn'));
  assert.ok(updated.records.every(record => record.history[0].state === 'provisional'));
  assert.equal(run({ action: 'history' }).runs[0].records[0].state, 'provisional');
  assert.equal(run({ action: 'admit', derivationId: result.records[0].derivationId }).reason, 'derived_state_withdrawn');
});

test('cycles terminate and the production result exposes budget exhaustion', t => {
  const { run } = fixture(t);
  const rules = [rule('r1', 'connected', 'knows'), rule('r2', 'knows', 'connected')];
  assert.equal(run({ rules }).evaluation.stoppedReason, 'fixpoint');
  assert.equal(run({ rules, limits: { maxOperations: 1 } }).evaluation.stoppedReason, 'max_operations');
  assert.throws(() => run({ rules, limits: { maxOperations: 100001 } }), /invalid inference limit/);
});

test('backward production query is provisional and workspace isolated', t => {
  const { kernel, run } = fixture(t);
  const query = atom('connected', [constant('Alice'), constant('Bob')]);
  const rules = [rule('r1', 'connected', 'knows')];
  const result = run({ action: 'query', query, rules });
  assert.equal(result.result.status, 'proven');
  assert.equal(result.authority, 'provisional');
  const other = run({ action: 'query', query, rules, workspaceId: 'other' });
  assert.notEqual(other.result.status, 'proven');
  assert.equal(kernel.graph.getAllEdges().length, 1);
  assert.equal(run({ action: 'history' }).runs.length, 0);
  assert.equal(factKey(result.snapshot.facts[0]), '["knows","Alice","Bob"]');
});

test('five independently observed contradictions defeat belief, withdraw conclusions and block rule reuse', t => {
  const { kernel, run } = fixture(t);
  const { decisionId } = require('../lib/inference-runtime-beliefs');
  const { readPredictionPairs } = require('../lib/prediction-outcome-pairs');
  for (let index = 1; index < 5; index++) {
    kernel.graph.addNode(`Alice${index}`, `Alice${index}`);
    kernel.graph.addEdge(`Alice${index}`, 'Bob', 'knows', { provenance: { provenanceId: `source-${index}`, sourceType: 'document' } });
  }
  const rules = [rule('causal-rule', 'CAUSES', 'knows')];
  const initial = run({ rules });
  assert.equal(initial.records.length, 5);
  const insufficient = run({ action: 'calibrate', ruleId: 'causal-rule', declaredConfidence: 0.9 });
  assert.equal(insufficient.beliefs[0].status, 'insufficient');
  assert.equal(insufficient.beliefs[0].observedSamples, 0);
  for (const record of initial.records) {
    kernel.graph.addEdge(record.fact.args[0].value, 'Bob', 'PREVENTS', { strength: 1, provenance: { provenanceId: `independent-${record.derivationId}`, sourceType: 'document' } });
  }
  const observed = run({ action: 'observe' });
  assert.equal(observed.effects.length, 5);
  assert.ok(observed.effects.every(effect => effect.outcome === 'contradiction'));
  const pairs = readPredictionPairs(kernel.graph);
  assert.equal(pairs[decisionId(initial.records[0])].outcome.state, 'contradiction');
  const revised = run({ action: 'calibrate', ruleId: 'causal-rule', declaredConfidence: 0.9 });
  assert.equal(revised.beliefs[0].status, 'defeated');
  assert.equal(revised.beliefs[0].declaredConfidence, 0.9);
  assert.ok(revised.beliefs[0].systemConfidence < 0.25);
  assert.ok(revised.records.every(record => record.state === 'withdrawn'));
  assert.equal(revised.beliefs[0].history[0].status, 'insufficient');
  assert.ok(revised.derivedBeliefs.every(item => item.status === 'defeated'));
  assert.equal(run({ rules }).evaluation.derivedCandidates.length, 0);
  assert.throws(() => run({ action: 'calibrate', ruleId: 'causal-rule', declaredConfidence: 0.99 }), /immutable/);
  assert.throws(() => run({ action: 'calibrate', ruleId: 'causal-rule', declaredConfidence: 0.9, allowLoosening: true }), /unsupported/);
});

test('reported-only outcomes do not calibrate without graph observations', t => {
  const { kernel, run } = fixture(t);
  const { decisionId } = require('../lib/inference-runtime-beliefs');
  const { recordOutcome } = require('../lib/prediction-outcome-pairs');
  const initial = run({ rules: [rule('reported', 'connected', 'knows')] });
  recordOutcome(kernel.graph, { decisionId: decisionId(initial.records[0]), outcome: 'confirmed', idempotencyKey: 'reported-confirmation' });
  assert.equal(run({ action: 'observe' }).effects.length, 0);
  const revised = run({ action: 'calibrate', ruleId: 'reported', declaredConfidence: 0.8 });
  assert.equal(revised.beliefs[0].observedSamples, 0);
  assert.equal(revised.beliefs[0].status, 'insufficient');
  assert.equal(run({ action: 'admit', derivationId: initial.records[0].derivationId }).reason, 'rule_belief_not_admissible');
});

test('audit refusal blocks inference before any journal or prediction mutation', t => {
  const { kernel, run } = fixture(t);
  kernel.recordCliMutationAudit = () => ({ auditRecorded: false });
  assert.throws(() => run({ rules: [rule('r1', 'connected', 'knows')] }));
  const { readRuns } = require('../lib/inference-runtime-store');
  assert.equal(readRuns(kernel.graph, 'default').length, 0);
});

test('journal state survives reopening the real JSON graph', t => {
  const { kernel, run, options } = fixture(t);
  const initial = run({ rules: [rule('restart', 'connected', 'knows')] });
  kernel.graph.save();
  const reopened = new Kernel({ ...options, noLoad: false });
  t.after(() => { reopened.graph.close(); reopened.memory?.close?.(); });
  const { runInference } = require('../lib/cli-inference-runtime');
  const history = runInference(reopened, { action: 'history' });
  assert.equal(history.runs[0].records[0].derivationId, initial.records[0].derivationId);
  assert.equal(runInference(reopened, { action: 'reconcile' }).records[0].state, 'provisional');
});

test('withdrawal downgrades the admitted projection atomically and contested reads block', t => {
  const { kernel, run } = fixture(t);
  const { transitionDerivedRecord } = require('../lib/inference-derived-record');
  const { commitRun } = require('../lib/inference-runtime-store');
  const { readClaim } = require('../lib/claim-read');
  const initial = run({ rules: [rule('projection', 'connected', 'knows')] });
  const record = transitionDerivedRecord(initial.records[0], 'admitted', { at: new Date().toISOString(), reason: 'admission_fixture', receiptId: 'retained-receipt' });
  // Seed an admitted state to target the projection withdrawal contract; this
  // fixture is deliberately not evidence of a successful production admission.
  kernel.graph.addEdge('Alice', 'Bob', 'connected', { provenance: { provenanceId: record.derivationId, sourceType: 'background_inference' }, confidence: 0.9 });
  commitRun(kernel.graph, 'default', initial.revision, { at: new Date().toISOString(), records: [record] });
  kernel.graph.addEdge('Alice', 'Bob', 'knows', { provenance: { provenanceId: 'new-source' } });
  const result = run({ action: 'reconcile' });
  assert.equal(result.records[0].state, 'withdrawn');
  assert.equal(result.records[0].trustReceiptId, 'retained-receipt');
  assert.equal(result.projectionChanges[0].previousEdge.confidence, 0.9);
  assert.equal(kernel.graph.getEdge('Alice', 'Bob', 'connected').confidence, 0);
  const read = readClaim(kernel, { workspaceId: 'default', targetId: 'Alice|connected|Bob', intent: { category: 'CANONICAL_GRAPH_WRITE' } });
  assert.equal(read.kind, 'unsettled');
  assert.equal(read.behavior, 'block');
});

test('canonical admission committed before runtime-state failure is recovered before withdrawal', t => {
  const { kernel, run } = fixture(t);
  const { admitDerivedRecord } = require('../lib/inference-derived-admission');
  const initial = run({ rules: [rule('recover', 'connected', 'knows')] });
  const record = initial.records[0];
  const originalAdmission = kernel._evaluateLearnAdmission;
  kernel._evaluateLearnAdmission = () => ({ outcome: 'allow', provenanceId: record.derivationId, receiptId: 'recovery-receipt',
    receipt: { receiptId: 'recovery-receipt', receiptKind: 'memory_admission_receipt', decision: 'allow', status: 'admitted',
      admissionId: 'recovery-admission', workspaceId: 'default', provenanceId: record.derivationId, trustPolicyVersion: 'fixture', createdAt: new Date().toISOString() } });
  // Fault-window fixture uses the real candidate transaction. The evaluator
  // is injected explicitly; this is durability evidence, not policy allow proof.
  const admitted = admitDerivedRecord(record, { ingestCandidateClaim: kernel.ingestCandidateClaim.bind(kernel) }, { at: new Date().toISOString(), requireCommittedReceipt: true });
  kernel._evaluateLearnAdmission = originalAdmission;
  assert.equal(admitted.status, 'admitted');
  assert.equal(run({ action: 'history' }).runs.at(-1).records[0].state, 'provisional');
  kernel.graph.addEdge('Alice', 'Bob', 'knows', { provenance: { provenanceId: 'support-replacement' } });
  const recovered = run({ action: 'reconcile' });
  assert.equal(recovered.records[0].state, 'withdrawn');
  assert.equal(recovered.records[0].trustReceiptId, 'recovery-receipt');
  assert.equal(kernel.graph.getEdge('Alice', 'Bob', 'connected').confidence, 0);
  assert.ok(recovered.records[0].history.some(event => event.reason === 'canonical_admission_recovered'));
});


test('calibrated inference cannot admit a different relation using an unrelated verified path', t => {
  const { kernel, run } = fixture(t);
  const provenance = index => ({ provenanceId: `bound-${index}`, sourceType: 'document', workspaceId: 'default' });
  for (let index = 0; index < 6; index++) {
    kernel.graph.addNode(`alice${index}`, `alice${index}`, provenance(index));
    kernel.graph.addNode('target', 'target', provenance(index));
    kernel.graph.addEdge(`alice${index}`, 'target', 'seed', { provenance: provenance(index), confidence: 0.9 });
  }
  const initial = run({ rules: [rule('binding', 'connected', 'seed')] });
  for (let index = 0; index < 5; index++) {
    kernel.graph.addEdge(`alice${index}`, 'target', 'connected', { provenance: provenance(`observation-${index}`), confidence: 0.9 });
  }
  run({ action: 'observe' });
  const calibrated = run({ action: 'calibrate', ruleId: 'binding', declaredConfidence: 0.5 });
  assert.equal(calibrated.beliefs[0].status, 'calibrated');
  kernel.graph.addEdge('alice5', 'target', 'CAUSES', { provenance: provenance('unrelated'), strength: 0.9, confidence: 0.9 });
  assert.equal(kernel.verify('alice5 connected target').data.status, 'verified');
  const pending = initial.records.find(record => record.fact.args[0].value === 'alice5');
  const admitted = run({ action: 'admit', derivationId: pending.derivationId });
  assert.equal(admitted.reason, 'verification_evidence_mismatch');
  assert.equal(admitted.records.find(record => record.derivationId === pending.derivationId).state, 'provisional');
  assert.equal(kernel.graph.getEdge('alice5', 'target', 'connected'), null);

});


test('exact verification still uses the existing admission review policy', t => {
  const { kernel, run } = fixture(t);
  const x = variable('X'), y = variable('Y');
  const rules = [createRule({ id: 'policy', head: atom('connected', [y, x]), body: [atom('seed', [x, y])] })];
  for (let index = 0; index < 5; index++) {
    const provenance = { provenanceId: `policy-${index}`, sourceType: 'document', workspaceId: 'default' };
    kernel.graph.addNode(`left${index}`, `left${index}`, provenance);
    kernel.graph.addNode(`right${index}`, `right${index}`, provenance);
    kernel.graph.addEdge(`left${index}`, `right${index}`, 'seed', { provenance, confidence: 0.9 });
  }
  const initial = run({ rules });
  for (let index = 0; index < 5; index++) {
    kernel.graph.addEdge(`right${index}`, `left${index}`, 'connected', {
      provenance: { provenanceId: `confirmation-${index}`, sourceType: 'document', workspaceId: 'default' }, confidence: 0.9,
    });
  }
  run({ action: 'observe' });
  assert.equal(run({ action: 'calibrate', ruleId: 'policy', declaredConfidence: 0.5 }).beliefs[0].status, 'calibrated');
  const result = run({ action: 'admit', derivationId: initial.records[0].derivationId });
  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'admission_review');
  assert.ok(result.records.every(record => record.state === 'provisional'));
});


test('verification contradiction withdraws dependent provisional conclusions in the same run', t => {
  const { kernel, run } = fixture(t);
  for (let index = 0; index < 6; index++) {
    const provenance = { provenanceId: `cascade-${index}`, sourceType: 'document', workspaceId: 'default' };
    kernel.graph.addNode(`actor${index}`, `actor${index}`, provenance);
    kernel.graph.addNode('outcome', 'outcome', provenance);
    kernel.graph.addEdge(`actor${index}`, 'outcome', 'seed', { provenance, confidence: 0.9 });
  }
  const initial = run({ rules: [rule('cause-cascade', 'CAUSES', 'seed'), rule('dependent-cascade', 'connected', 'CAUSES')] });
  for (let index = 0; index < 5; index++) {
    kernel.graph.addEdge(`actor${index}`, 'outcome', 'CAUSES', {
      provenance: { provenanceId: `cascade-confirmed-${index}`, sourceType: 'document', workspaceId: 'default' }, confidence: 0.9, strength: 0.9,
    });
  }
  run({ action: 'observe' });
  assert.equal(run({ action: 'calibrate', ruleId: 'cause-cascade', declaredConfidence: 0.5 }).beliefs[0].status, 'calibrated');
  kernel.graph.addEdge('actor5', 'outcome', 'PREVENTS', {
    provenance: { provenanceId: 'cascade-opposition', sourceType: 'document', workspaceId: 'default' }, confidence: 0.9, strength: 0.9,
  });
  assert.equal(kernel.verify('actor5 CAUSES outcome').data.status, 'contradicted');
  const parent = initial.records.find(record => record.ruleId === 'cause-cascade' && record.fact.args[0].value === 'actor5');
  const child = initial.records.find(record => record.ruleId === 'dependent-cascade' && record.fact.args[0].value === 'actor5');
  const updated = run({ action: 'admit', derivationId: parent.derivationId });
  assert.equal(updated.records.find(record => record.derivationId === parent.derivationId).state, 'contradicted');
  assert.equal(updated.records.find(record => record.derivationId === child.derivationId).state, 'withdrawn');
  assert.equal(run({ action: 'history' }).runs[0].records.find(record => record.derivationId === child.derivationId).state, 'provisional');
});
