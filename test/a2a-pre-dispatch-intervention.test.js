'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { createA2aHandoffDispatcher } = require('../index');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { evaluateBoundedExchange } = require('../lib/a2a/bounded-exchange');
const { createA2aExchangeBoundary } = require('../lib/a2a/exchange-route');
const { evaluateA2aAgentActionFirewall } = require('../lib/a2a/exchange-route-firewall');
const { evaluateAgentActionFirewall } = require('../lib/agent-action-firewall');
const { buildFixture } = require('../scripts/a2a-conformance/run-fixture');
const { clone, rebindAll, EVALUATION_TIME } = require('../scripts/a2a-conformance/run-support');
const { canonicalHash } = require('../lib/a2a/bounded-exchange-values');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-intervention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(root, 'graph.json') });
  const fixture = buildFixture('default');
  const ledger = createTrustEvidenceLedger({ graph });
  const sequence = [];
  let sent = 0;
  const options = {
    graph, workspaceId: 'default', sourceAgentId: 'agent-source', policyVersion: 'v5-d6-1',
    now: () => EVALUATION_TIME,
    intervention: message => {
      sequence.push('intervention');
      assert.ok(Object.isFrozen(message.requestedAction));
      return { decision: 'allow', reason: 'host_allowed' };
    },
    prepare: message => {
      sequence.push('prepare');
      const request = clone(message);
      rebindAll(fixture, request);
      return request;
    },
    verify: request => {
      sequence.push('verify');
      return evaluateBoundedExchange({ request, authority: fixture.authority,
        evaluationTime: EVALUATION_TIME, replayReserve: () => ({ reserved: true }), effect: () => ({ preflight: true }) });
    },
    admission: request => {
      sequence.push('admission');
      return evaluateA2aAgentActionFirewall(request, fixture.authority, evaluateAgentActionFirewall);
    },
    dispatch: message => {
      sequence.push('dispatch');
      sent += 1;
      assert.equal(ledger.readByOperation(`a2a-intervention:${canonicalHash({ workspaceId: 'default',
        sourceAgentId: 'agent-source', exchangeId: message.exchangeId })}`).verification.valid, true);
      return { transportReceived: true };
    },
  };
  return { root, graph, fixture, ledger, options, sequence, sent: () => sent };
}

test('public SDK allow runs intervention before admission and persists before transport', async t => {
  const s = sandbox(t);
  const dispatcher = createA2aHandoffDispatcher(s.options);
  const result = await dispatcher.handoff(s.fixture.request);
  assert.equal(result.status, 'dispatched');
  assert.equal(result.decision, 'allow');
  assert.equal(result.dispatchAttempted, true);
  assert.ok(result.receipt.receiptHash);
  assert.ok(result.outcomeReceipt.receiptHash);
  assert.deepEqual(s.sequence, ['intervention', 'prepare', 'verify', 'admission', 'dispatch']);
  assert.equal(s.sent(), 1);
  assert.equal(JSON.stringify(result.receipt).includes('requestBody'), false);
});

test('host options mutation cannot replace the dispatcher durability authority', async t => {
  const s = sandbox(t);
  const dispatcher = createA2aHandoffDispatcher(s.options);
  s.options.graph = { runMutationOnce() { throw new Error('replaced graph'); } };
  assert.equal((await dispatcher.handoff(s.fixture.request)).status, 'dispatched');
  assert.equal((await dispatcher.handoff(s.fixture.request)).status, 'replayed');
  assert.equal(s.sent(), 1);
});

test('invalid target data still leaves a bounded refusal receipt', async t => {
  const s = sandbox(t);
  const request = clone(s.fixture.request);
  request.target.agentId = { token: 'untrusted-secret' };
  const result = await createA2aHandoffDispatcher(s.options).handoff(request);
  assert.equal(result.status, 'dropped');
  assert.equal(result.reason, 'handoff_invalid');
  assert.ok(result.receipt.receiptHash);
  assert.equal(JSON.stringify(result.receipt).includes('untrusted-secret'), false);
  assert.equal(s.sent(), 0);
  assert.deepEqual(s.sequence, []);
});

test('drop leaves a durable receipt and never enters prepare, admission or transport', async t => {
  const s = sandbox(t);
  s.options.intervention = () => ({ decision: 'drop', reason: 'unsafe_handoff' });
  const result = await createA2aHandoffDispatcher(s.options).handoff(s.fixture.request);
  assert.equal(result.decision, 'drop');
  assert.equal(result.reason, 'unsafe_handoff');
  assert.equal(result.status, 'dropped');
  assert.equal(result.receipt.canonicalPayload.decision, 'block');
  assert.equal(result.receipt.canonicalPayload.metadata.interventionDecision, 'drop');
  assert.equal(s.sent(), 0);
  assert.deepEqual(s.sequence, []);
  const restarted = new Graph({ useSQLite: false, memoryPath: path.join(s.root, 'graph.json') });
  const stored = createTrustEvidenceLedger({ graph: restarted }).readByOperation(result.receipt.operationId);
  assert.equal(stored.verification.valid, true);
  assert.equal(stored.receipt.receiptId, result.receipt.receiptId);
});

test('modify narrows constraints, rebinds real signatures and reaches the receiver unchanged', async t => {
  const s = sandbox(t);
  const replayDirectory = path.join(s.root, 'replay');
  fs.mkdirSync(replayDirectory);
  const authorityFile = path.join(s.root, 'authority.json');
  fs.writeFileSync(authorityFile, JSON.stringify(s.fixture.authority));
  const receiver = createA2aExchangeBoundary({ authorityFile, replayDirectory });
  assert.ok(receiver);
  s.options.intervention = message => {
    const candidate = clone(message);
    candidate.constraints.allowedTools = [candidate.requestedAction.tool];
    candidate.constraints.allowedConnectors = [candidate.requestedAction.connector];
    candidate.requestedAction.parametersHash = canonicalHash({ claimId: 'claim:revised' });
    return { decision: 'modify', reason: 'bounded_parameters', message: candidate };
  };
  s.options.dispatch = async request => {
    assert.notEqual(request.requestedAction.parametersHash, s.fixture.request.requestedAction.parametersHash);
    assert.notEqual(request.signature.value, s.fixture.request.signature.value);
    assert.notEqual(request.routeReceipt.action_ref, s.fixture.request.routeReceipt.action_ref);
    return receiver.handle({ method: 'POST' }, async () => ({ ok: true, data: request }));
  };
  const result = await createA2aHandoffDispatcher(s.options).handoff(s.fixture.request);
  assert.equal(result.decision, 'modify');
  assert.equal(result.status, 'dispatched');
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.decision, 'allow');
  const task = result.response.body.effect.taskId;
  assert.ok(fs.existsSync(path.join(replayDirectory, `${task}.completed`)));
  assert.notEqual(result.receipt.canonicalPayload.metadata.originalHash,
    result.receipt.canonicalPayload.metadata.effectiveHash);
});

test('scope expansion, unknown/throwing handler and hidden getters fail closed', async t => {
  const s = sandbox(t);
  const mutations = [
    m => { m.workspaceId = 'other'; },
    m => { m.target.agentId = 'attacker'; },
    m => { m.constraints.allowedTools.push('shell.exec'); },
    m => { m.requestedAction.riskTier = 'critical'; },
    m => { m.requestedAction.approved = true; },
  ];
  for (let i = 0; i < mutations.length; i++) {
    const original = clone(s.fixture.request);
    original.exchangeId = `scope-${i}`;
    s.options.intervention = message => {
      const changed = clone(message); mutations[i](changed);
      return { decision: 'modify', reason: 'untrusted', message: changed };
    };
    const result = await createA2aHandoffDispatcher(s.options).handoff(original);
    assert.equal(result.status, 'dropped');
    assert.equal(result.reason, 'intervention_scope_expansion');
  }
  let invalidIndex = 0;
  for (const intervention of [() => ({ decision: 'unknown', reason: 'unknown' }),
    () => { throw new Error('untrusted'); },
    () => ({ decision: 'allow', get reason() { throw new Error('getter must not run'); } })]) {
    const original = clone(s.fixture.request); original.exchangeId = `invalid-${invalidIndex++}`;
    s.options.intervention = intervention;
    const result = await createA2aHandoffDispatcher(s.options).handoff(original);
    assert.equal(result.status, 'dropped');
    assert.ok(result.receipt);
  }
  assert.equal(s.sent(), 0);
});

test('invalid preparation, verification and admission each refuse before transport', async t => {
  const s = sandbox(t);
  for (const stage of ['prepare', 'verify', 'admission']) {
    const options = { ...s.options };
    options[stage] = stage === 'prepare' ? () => ({}) : () => ({ decision: 'review', reason: 'not_allowed' });
    const original = clone(s.fixture.request); original.exchangeId = stage;
    const result = await createA2aHandoffDispatcher(options).handoff(original);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, `${stage}_failed`);
    assert.equal(result.dispatchAttempted, false);
    assert.ok(result.receipt);
  }
  assert.equal(s.sent(), 0);
});

test('receipt failure blocks dispatch; post-dispatch failure is visible and cannot resend', async t => {
  const s = sandbox(t);
  const originalMutation = s.graph.runMutationOnce.bind(s.graph);
  s.graph.runMutationOnce = () => { throw new Error('disk_unavailable'); };
  const blocked = await createA2aHandoffDispatcher(s.options).handoff(s.fixture.request);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'intervention_receipt_failed');
  assert.equal(s.sent(), 0);
  s.graph.runMutationOnce = (id, ...args) => {
    if (id.endsWith(':delivery')) throw new Error('outcome_disk_unavailable');
    return originalMutation(id, ...args);
  };
  const dispatcher = createA2aHandoffDispatcher(s.options);
  const result = await dispatcher.handoff(s.fixture.request);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'delivery_receipt_failed');
  assert.equal(result.dispatchAttempted, true);
  assert.equal(result.deliveryRecorded, false);
  assert.equal((await dispatcher.handoff(s.fixture.request)).status, 'replayed');
  assert.equal(s.sent(), 1);
});

test('concurrent handoffs and restarted dispatcher cannot send the same exchange twice', async t => {
  const s = sandbox(t);
  const a = createA2aHandoffDispatcher(s.options);
  const b = createA2aHandoffDispatcher(s.options);
  const results = await Promise.all([a.handoff(s.fixture.request), b.handoff(s.fixture.request)]);
  assert.equal(results.filter(r => r.status === 'dispatched').length, 1);
  assert.equal(s.sent(), 1);
  const restartedGraph = new Graph({ useSQLite: false, memoryPath: path.join(s.root, 'graph.json') });
  const replay = await createA2aHandoffDispatcher({ ...s.options, graph: restartedGraph }).handoff(s.fixture.request);
  assert.equal(replay.status, 'replayed');
  assert.equal(s.sent(), 1);
  const changed = clone(s.fixture.request); changed.nonce = 'different';
  const conflict = await createA2aHandoffDispatcher({ ...s.options, graph: restartedGraph }).handoff(changed);
  assert.equal(conflict.reason, 'handoff_identity_conflict');
});

test('timeout and uncertain delivery remain fail closed and replay never retries transport', async t => {
  const s = sandbox(t);
  const pending = new Promise(() => {});
  const dropping = createA2aHandoffDispatcher({ ...s.options, timeoutMs: 10, intervention: () => pending });
  assert.equal((await dropping.handoff(s.fixture.request)).status, 'dropped');
  assert.equal(s.sent(), 0);
  const request = clone(s.fixture.request); request.exchangeId = 'delivery-unknown';
  const sender = createA2aHandoffDispatcher({ ...s.options, timeoutMs: 10, dispatch: () => pending });
  const result = await sender.handoff(request);
  assert.equal(result.status, 'unknown');
  assert.equal(result.dispatchAttempted, true);
  assert.equal(result.reason, 'delivery_unknown');
  assert.equal((await sender.handoff(request)).status, 'replayed');
});

test('the losing concurrent dispatcher reports the reserved delivery as unknown', async t => {
  const s = sandbox(t);
  let attempts = 0;
  const options = { ...s.options, timeoutMs: 20, dispatch: () => {
    attempts += 1;
    return new Promise(() => {});
  } };
  const a = createA2aHandoffDispatcher(options);
  const b = createA2aHandoffDispatcher(options);
  const results = await Promise.all([a.handoff(s.fixture.request), b.handoff(s.fixture.request)]);
  assert.equal(attempts, 1);
  const replay = results.find(result => result.status === 'replayed');
  assert.equal(replay.previousOutcome, 'delivery_unknown');
  assert.equal(replay.dispatchAttempted, false);
  assert.equal(typeof replay.deliveryRecorded, 'boolean');
  assert.ok(replay.receipt.receiptHash);
});

test('malformed transport responses record uncertainty and replay preserves it', async t => {
  const s = sandbox(t);
  s.options.dispatch = () => ({ get accepted() { throw new Error('getter must not run'); } });
  const dispatcher = createA2aHandoffDispatcher(s.options);
  const first = await dispatcher.handoff(s.fixture.request);
  assert.equal(first.status, 'unknown');
  assert.equal(first.outcomeReceipt.canonicalPayload.executionOutcome, 'delivery_unknown');
  const replay = await dispatcher.handoff(s.fixture.request);
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.previousOutcome, 'delivery_unknown');
  assert.equal(replay.outcomeReceipt.receiptHash, first.outcomeReceipt.receiptHash);
  assert.equal(replay.dispatchAttempted, false);
});

test('missing trust collaborators and non-finite deadlines are rejected at construction', t => {
  const s = sandbox(t);
  for (const name of ['intervention', 'prepare', 'verify', 'admission', 'dispatch']) {
    assert.throws(() => createA2aHandoffDispatcher({ ...s.options, [name]: undefined }), new RegExp(name));
  }
  assert.throws(() => createA2aHandoffDispatcher({ ...s.options, timeoutMs: NaN }), /timeoutMs/);
});
