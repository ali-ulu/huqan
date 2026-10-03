'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectCoderCanary } = require('../lib/experience/coder-canary-runtime');
const { replayCoderTrust } = require('../lib/experience/coder-trust-replay');
const { createCapabilityTrustRegistry } = require('../lib/experience/capability-trust');

function history() {
  const rows = new Map();
  return { rows, runIds: () => [...rows.keys()], read: id => rows.get(id)?.events || [],
    manifest: id => rows.get(id)?.manifest };
}

function add(journal, id, at, cost, routing, eligibility = 'positive_procedure') {
  journal.rows.set(id, { manifest: { closed: true, learningEligibility: eligibility }, events: [
    { eventId: `${id}:start`, type: 'run_started', payload: { createdAt: new Date(at).toISOString() } },
    { eventId: `${id}:action`, type: 'action_proposed', payload: { path: 'docs/a.md', operationType: 'replace_text' } },
    ...(routing ? [{ eventId: `${id}:route`, type: 'routing_decided', payload: routing }] : []),
    { eventId: `${id}:finished`, type: 'execution_finished', payload: {} },
    { eventId: `${id}:close`, type: 'run_closed', payload: { measurements: {
      executionCost: cost, verificationCost: 0, canaryOverheadCost: 0,
    } } },
  ] });
}

test('canary compares equally sized latest windows independently of journal iteration order', () => {
  const journal = history();
  const now = Date.now() - 100000;
  const seeds = [];
  // Reverse chronology mimics lexical run-id ordering after SQLite reopen.
  for (let index = 39; index >= 0; index -= 1) {
    const id = `baseline-${index}`;
    seeds.push(id);
    add(journal, id, now + index, index >= 30 ? 1 : 100);
  }
  const input = { config: { candidates: [{ capabilityId: 'base', sourceRunIds: seeds }],
    canary: { trialId: 'trial', baselineCapabilityId: 'base', candidateCapabilityId: 'candidate' } },
  journal, workspaceId: 'ws', requestId: 'next',
  candidates: [{ capabilityId: 'base' }, { capabilityId: 'candidate' }], procedureHash: 'bound' };
  const initial = selectCoderCanary(input);
  assert.equal(initial.ok, true);
  for (let index = 9; index >= 0; index -= 1) {
    add(journal, `candidate-${index}`, now + 50 + index, 2, {
      chosenCapabilityId: 'candidate', canary: initial.canary,
    });
  }
  const result = selectCoderCanary(input);
  assert.equal(result.ok, true);
  assert.equal(result.canary.evaluation.status, 'failed');
  const rows = [...journal.runIds()].map(id => [id, journal.read(id), journal.manifest(id)]).reverse();
  const reversed = { runIds: () => rows.map(row => row[0]),
    read: id => rows.find(row => row[0] === id)?.[1], manifest: id => rows.find(row => row[0] === id)?.[2] };
  assert.deepEqual(selectCoderCanary({ ...input, journal: reversed }).canary.evaluation, result.canary.evaluation);
});

test('trust replay includes routed negative history omitted from positive source seeds', () => {
  const journal = history();
  const now = Date.now() - 100000;
  const seeds = [];
  for (let index = 0; index < 25; index += 1) {
    const id = `positive-${index}`;
    seeds.push(id);
    add(journal, id, now + index, 1);
  }
  for (let index = 0; index < 3; index += 1) add(journal, `negative-${index}`, now + 30 + index, 1,
    { chosenCapabilityId: 'replace', boundProcedureVersion: 'bound' }, 'negative_example');
  add(journal, 'fallback', now + 40, 1, { fallback: { capabilityIds: ['replace'] } });
  const trust = createCapabilityTrustRegistry();
  assert.equal(trust.createCapability({ workspaceId: 'ws', capabilityId: 'replace', boundProcedureVersion: 'bound' }).ok, true);
  assert.equal(replayCoderTrust({ journal, workspaceId: 'ws', requestId: 'next', capabilityId: 'replace',
    procedureHash: 'bound', trust, seededRunIds: seeds }).ok, true);
  assert.equal(trust.get('ws', 'replace').trustState, 'demoted');
  assert.equal(trust.get('ws', 'replace').fallbackPreferredOverCount, 1);
});
