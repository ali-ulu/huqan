'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareCognition, buildRouteInfo } = require('../lib/agent-cognition-seam');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');

const frame = { repo: 'fixture', branch: 'main', commit: 'v1', environment: 'test', actor: 'host',
  time: '2026-10-29T00:00:00Z', goal: 'artifact validation', task: 'digest-check-v1' };
// dualProcess hard-requires predictionError/value/salience (FLAG_REQUIRES).
const dualFlags = { predictionError: true, reward: true, value: true, percept: true, salience: true, dualProcess: true };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-seam-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'graph.json') });
  const state = { workspaceId: 'default', observabilityRunId: 'r', iteration: 0, goal: frame.goal };
  const opts = { cognition: dualFlags, cognitiveScheduler: {}, cognitionFrame: frame };
  return { graph, state, opts };
}

test('dualProcess annotations never touch the queued steps and stay advice-only', t => {
  const f = fixture(t);
  const queued = [{ id: 'a', tool: 'ask', riskTier: 'high' }, { id: 'b', tool: 'compare', riskTier: 'low' }];
  const before = JSON.stringify(queued);
  const result = prepareCognition({ ...f, queued, goal: frame.goal });
  assert.equal(result.status, 'MEASURED');
  assert.equal(JSON.stringify(queued), before);
  const advice = f.state.cognition.advice;
  assert.deepEqual(Object.keys(advice).sort(), ['a', 'b']);
  for (const key of Object.keys(advice)) {
    assert.equal(advice[key].executes, false);
    assert.equal(advice[key].authority, 'ROUTING_ADVICE_ONLY');
    assert.equal(advice[key].routeRef.requestId, key);
    // No host-declared compiled procedure for these steps, so the route carries
    // no capability id (the router then reports no_compiled_procedure).
    assert.equal(advice[key].routeRef.chosenCapabilityId, null, `chosenCapabilityId should be null for ${key}`);
  }
  // Unknown risk deliberates before anything else.
  assert.equal(advice.a.mode, 'SYSTEM2');
  assert.equal(advice.a.reasons[0], 'risk_requires_deliberation');
  // Low risk but no compiled procedure -> SYSTEM2 (rule 2 precedes the trust gate).
  assert.equal(advice.b.mode, 'SYSTEM2');
  assert.equal(advice.b.reasons[0], 'no_compiled_procedure');
});

test('a host-declared compiled procedure lets the route carry a capability id', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-proc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'artifact.txt');
  fs.writeFileSync(target, 'before');
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'graph.json') });
  const state = { workspaceId: 'default', observabilityRunId: 'r', iteration: 0, goal: frame.goal };
  const opts = { cognition: dualFlags, cognitiveScheduler: {}, cognitionFrame: frame,
    cognitionFileExpectations: { a: { workspaceId: 'default', path: target,
      expectedDigest: 'a'.repeat(64), sourceGroup: 'artifact-group', riskScore: 0 } } };
  const queued = [{ id: 'a', tool: 'ask', riskTier: 'low' }];
  assert.equal(prepareCognition({ graph, state, opts, queued, goal: frame.goal }).status, 'MEASURED');
  const advice = state.cognition.advice.a;
  assert.equal(advice.routeRef.chosenCapabilityId, 'ask::a');
  // No value ledger entry -> insufficient-data -> SYSTEM2 (the trust gate).
  assert.equal(advice.mode, 'SYSTEM2');
  assert.equal(advice.reasons[0], 'trust_insufficient_data');
});

test('without the dualProcess flag no advice map is created', t => {
  const f = fixture(t);
  f.opts.cognition = { ...dualFlags, dualProcess: false };
  const queued = [{ id: 'a', tool: 'ask', riskTier: 'high' }];
  const result = prepareCognition({ ...f, queued, goal: frame.goal });
  assert.equal(result.status, 'MEASURED');
  assert.equal(f.state.cognition.advice, undefined);
});

test('an impossible dualProcess config REJECTs the whole prepare and opens nothing', t => {
  const f = fixture(t);
  f.opts.cognition = { dualProcess: true };
  const queued = [{ id: 'a', tool: 'ask' }];
  assert.equal(prepareCognition({ ...f, queued, goal: frame.goal }), null);
  const last = f.state.cognition.trail.at(-1);
  assert.equal(last.status, 'REJECT');
  assert.match(last.reason, /missing_dependency:dualProcess->salience/);
  assert.equal(f.state.cognition.advice, undefined);
});

test('the advice map stays bounded at 32 entries, pruning oldest first', t => {
  const f = fixture(t);
  for (let i = 0; i < 34; i++) {
    const queued = [{ id: `s-${i}`, tool: 'ask', riskTier: 'high' }];
    assert.equal(prepareCognition({ ...f, queued, goal: frame.goal }).status, 'MEASURED');
  }
  const advice = f.state.cognition.advice;
  assert.deepEqual(Object.keys(advice).length === 32, true);
  assert.equal(advice['s-0'], undefined);
  assert.equal(advice['s-1'], undefined);
  assert.ok(advice['s-33']);
});

test('buildRouteInfo gates trusted on observed success, not on source count alone', () => {
  const candidate = { family: 'ask', key: 'a' };
  // Four independent sources but a minority of confirmed outcomes: not trusted.
  const lowSuccess = { status: 'MEASURED', supportScore: 0.9, success: { p: 0.2 } };
  assert.equal(buildRouteInfo(candidate, lowSuccess, {}).trustState, 'probationary');
  // A confirmed majority at sufficient support earns the fast path.
  const highSuccess = { status: 'MEASURED', supportScore: 0.9, success: { p: 0.8 } };
  assert.equal(buildRouteInfo(candidate, highSuccess, {}).trustState, 'trusted');
  // Support below the floor stays probationary even with a high success rate.
  const lowSupport = { status: 'MEASURED', supportScore: 0.3, success: { p: 0.9 } };
  assert.equal(buildRouteInfo(candidate, lowSupport, {}).trustState, 'probationary');
  // No entry, or a non-MEASURED entry, is insufficient-data.
  assert.equal(buildRouteInfo(candidate, undefined, {}).trustState, 'insufficient-data');
  assert.equal(buildRouteInfo(candidate, { status: 'INSUFFICIENT' }, {}).trustState, 'insufficient-data');
});

test('buildRouteInfo only emits a capability id when a compiled procedure exists', () => {
  const candidate = { family: 'coder:refactor', key: 'step-1' };
  const withProcedure = buildRouteInfo(candidate, undefined, { binding: {} });
  assert.equal(withProcedure.chosenCapabilityId, 'coder:refactor::step-1');
  const withoutProcedure = buildRouteInfo(candidate, undefined, undefined);
  assert.equal(withoutProcedure.chosenCapabilityId, null);
  assert.equal(withoutProcedure.refusalReason, null);
});
