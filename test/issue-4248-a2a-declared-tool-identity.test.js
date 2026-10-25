'use strict';

// #4248: the AB5 firewall decision keyed on the caller-declared tool name. A
// read-only tool name (`verify`, `axiom.verify`) short-circuited the firewall
// before AB5 ran, so a caller could declare `axiom.verify` while its requested
// action named a mutating capability (`deploy`, `repo.force-push`) or carried a
// shell command, and the delegation was admitted. The declared name is not
// evidence of what will run, so an action outside the read vocabulary -- or one
// that names a shell command -- must fall through to AB5 rather than inherit
// the read-only allow.
//
// These tests drive the real A2A firewall seam with the conformance fixture, so
// a regression fails at the surface the issue describes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFixture } = require('../scripts/a2a-conformance/run');
const { evaluateAgentActionFirewall } = require('../lib/agent-action-firewall');
const { evaluateA2aAgentActionFirewall } = require('../lib/a2a/exchange-route-firewall');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('an A2A exchange that declares a read tool but asks for a mutating capability does not inherit the read-only allow', () => {
  const { authority, request } = buildFixture();

  const honest = clone(request);
  const honestDecision = evaluateA2aAgentActionFirewall(honest, authority, evaluateAgentActionFirewall);
  assert.equal(honestDecision.decision, 'allow', 'the fixture is a genuine read-shaped exchange');

  for (const capability of ['deploy', 'repo.force-push', 'merge']) {
    const forged = clone(request);
    forged.requestedAction.capability = capability;
    const decision = evaluateA2aAgentActionFirewall(forged, authority, evaluateAgentActionFirewall);
    assert.notEqual(decision.decision, 'allow', `declaring axiom.verify must not allow ${capability}`);
    assert.notEqual(decision.reason, 'AGENT_READ_ONLY_ACTION_ALLOWED');
  }
});

test('a read tool that carries a shell command falls through to AB5 instead of the read-only allow', () => {
  const deploy = evaluateAgentActionFirewall({
    surface: 'agent',
    tool: 'verify',
    action: 'deploy production',
    input: { action: 'deploy production', operationType: 'deploy', command: 'git push --force origin main' },
  });
  assert.equal(deploy.decision, 'block');
  assert.equal(deploy.reason, 'DEPLOY_REQUIRES_APPROVAL');

  const shellOnly = evaluateAgentActionFirewall({
    surface: 'agent',
    tool: 'verify',
    action: 'verify claim',
    input: { command: 'rm -rf /' },
  });
  assert.notEqual(shellOnly.decision, 'allow');
  assert.notEqual(shellOnly.reason, 'AGENT_READ_ONLY_ACTION_ALLOWED');
});

test('a genuine read-shaped action on a read tool keeps its read-only allow', () => {
  const decision = evaluateAgentActionFirewall({
    surface: 'agent',
    tool: 'verify',
    action: 'verify claim',
    input: { action: 'verify claim', target: 'claim:1' },
  });
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.reason, 'AGENT_READ_ONLY_ACTION_ALLOWED');

  const plain = evaluateAgentActionFirewall({
    surface: 'agent',
    tool: 'ask',
    action: 'ask',
    input: 'Explain the deployment policy.',
  });
  assert.equal(plain.decision, 'allow');

  // The action is the tool's own name, or empty: still read-shaped.
  const byName = evaluateAgentActionFirewall({ surface: 'agent', tool: 'verify', input: { target: 'claim:1' } });
  assert.equal(byName.decision, 'allow');
  const emptyAction = evaluateAgentActionFirewall({ surface: 'agent', tool: 'plan', action: '', input: {} });
  assert.equal(emptyAction.decision, 'allow');
});