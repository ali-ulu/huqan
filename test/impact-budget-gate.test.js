'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { evaluateExternalAction } = require('../lib/external-action-guard');
const { readBudgetState, reserveImpact, commitReservation } = require('../lib/impact-budget-ledger');

const workspaceRoot = path.resolve(__dirname, '..');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-budget-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryGraph(dir) {
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

const POLICY = Object.freeze({ policyVersion: 'policy-v1', reviewAt: 200, quorumAt: 300, blockAt: 400 });

function invocation(overrides = {}) {
  return {
    invocationId: 'budget-1',
    agentName: 'budget-agent',
    sessionId: 'budget-session',
    toolName: 'Bash',
    args: { command: 'git status' },
    cwd: workspaceRoot,
    workspaceRoot,
    workspaceId: 'default',
    ...overrides,
  };
}

function options(graph, overrides = {}) {
  return {
    allowedCommands: ['git status'],
    requireIdentityCard: false,
    receiptWriter: null,
    ...(graph ? { impactBudget: { graph, policy: POLICY } } : {}),
    ...overrides,
  };
}

function budgetFinding(result) {
  return result.findings.find((finding) => finding.gate === 'impact-budget');
}

test('disarmed guard evaluates exactly as before, with no budget finding', () => {
  const result = evaluateExternalAction(invocation(), options(null));
  assert.equal(budgetFinding(result), undefined);
});

test('an under-budget allow commits its score and stays allowed', (t) => {
  const graph = memoryGraph(tempDir(t));
  const result = evaluateExternalAction(invocation(), options(graph));
  const finding = budgetFinding(result);
  assert.ok(finding, 'the armed gate always records its finding');
  assert.equal(finding.decision, 'allow');
  assert.equal(finding.enforced, true);
  const state = readBudgetState(graph, { policyVersion: 'policy-v1', workspaceId: 'default', sessionId: 'budget-session' });
  assert.ok(state.committed > 0, 'an allowed action commits its blast score');
  assert.equal(state.reserved, 0);
});

test('a projected-over-budget action blocks and consumes nothing', (t) => {
  const graph = memoryGraph(tempDir(t));
  reserveImpact(graph, {
    scope: { policyVersion: 'policy-v1', workspaceId: 'default', sessionId: 'budget-session' },
    amount: 390,
    idempotencyKey: 'prior',
  });
  commitReservation(graph, { reservationId: 'res:prior', idempotencyKey: 'prior-commit' });
  const result = evaluateExternalAction(invocation(), options(graph));
  assert.equal(result.decision, 'block');
  assert.equal(budgetFinding(result).reason, 'external_action_impact_budget_blocked');
  const state = readBudgetState(graph, { policyVersion: 'policy-v1', workspaceId: 'default', sessionId: 'budget-session' });
  assert.equal(state.committed, 390, 'the denied action consumed nothing');
});

test('a gate-denied action consumes nothing even when armed', (t) => {
  const graph = memoryGraph(tempDir(t));
  const result = evaluateExternalAction(
    invocation({ args: { command: 'rm -rf /' } }),
    options(graph, { allowedCommands: [] }),
  );
  assert.equal(result.decision, 'block');
  const state = readBudgetState(graph, { policyVersion: 'policy-v1', workspaceId: 'default', sessionId: 'budget-session' });
  assert.deepEqual([state.reserved, state.committed], [0, 0]);
});

test('missing scope and broken graphs degrade to review, never throw', (t) => {
  const graph = memoryGraph(tempDir(t));
  const nosession = evaluateExternalAction(
    invocation({ sessionId: '   ' }),
    options(graph),
  );
  assert.equal(nosession.decision, 'block');
  assert.equal(
    nosession.findings.find((finding) => finding.gate === 'envelope').reason,
    'malformed_external_action_blocked',
    'a sessionless invocation never reaches the budget gate',
  );

  const { evaluateImpactBudget } = require('../lib/impact-budget-gate');
  const degraded = evaluateImpactBudget({
    envelope: { workspaceId: 'default', session: { id: '' } },
    decision: 'allow',
    riskLevel: 'LOW',
    options: { impactBudget: { graph, policy: POLICY } },
  });
  assert.equal(degraded.finding.decision, 'review');
  assert.equal(degraded.finding.reason, 'external_action_impact_budget_degraded_review');

  const broken = { runMutationOnce: () => { throw new Error('store down'); }, getCommittedMutationResultsByPrefix: () => { throw new Error('store down'); } };
  const result = evaluateExternalAction(invocation(), options(broken));
  assert.equal(result.decision, 'review');
  assert.ok(budgetFinding(result));
});
