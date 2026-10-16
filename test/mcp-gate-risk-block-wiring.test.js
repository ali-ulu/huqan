'use strict';

// The MCP gate adapter converts a 0-1 sub-gate score to the canonical 0-100
// scale on every path that takes one (#2505). The characterisation fixture
// reaches the AB4 and AB5 blocks through real inputs but never an AB2 block, so
// the three block paths and the AB5 finding are driven here with stubbed
// sub-gate results.
//
// The stubs are installed before the adapter loads, because it reads these
// exports when it is required. Each test file runs in its own process.

const assert = require('node:assert/strict');
const test = require('node:test');

const toolCallGate = require('../lib/tool-call-gate');
const memoryMutationGate = require('../lib/memory-mutation-gate');
const automationSafetyGate = require('../lib/automation-safety-gate');

const stubs = { ab2: null, ab4: null, ab5: null };
const real = {
  ab2: toolCallGate.evaluateToolCall,
  ab4: memoryMutationGate.evaluateMemoryMutation,
  ab5: automationSafetyGate.evaluateAutomationSafety,
};
toolCallGate.evaluateToolCall = (input) => (stubs.ab2 ? stubs.ab2 : real.ab2(input));
memoryMutationGate.evaluateMemoryMutation = (input) => (stubs.ab4 ? stubs.ab4 : real.ab4(input));
automationSafetyGate.evaluateAutomationSafety = (input) => (stubs.ab5 ? stubs.ab5 : real.ab5(input));

const { evaluateMcpGate, MCP_GATE_DECISIONS } = require('../lib/mcp-gate-adapter');

function withStubs(next, fn) {
  Object.assign(stubs, { ab2: null, ab4: null, ab5: null }, next);
  try {
    return fn();
  } finally {
    Object.assign(stubs, { ab2: null, ab4: null, ab5: null });
  }
}

const BENIGN_LEARN = { tool: 'huqan.learn', args: { text: 'water boils at 100 degrees' }, metadata: {} };
const BENIGN_AGENT = { tool: 'huqan.agent', args: { goal: 'summarise the repo' }, metadata: {} };

// Each block's level is the action-taxonomy band of its converted score, not
// the sub-gate's own label: 90 is critical, 42 medium, 70 high (#2505).
test('an AB2 block reports its 0-1 risk on the 0-100 scale, levelled by that score', () => {
  const result = withStubs({
    ab2: {
      decision: toolCallGate.TOOL_GATE_DECISIONS.block,
      reason: 'stubbed_block',
      canDryRun: false,
      requiredReview: false,
      risk: { level: 'high', score: 0.9, category: 'tool-call' },
    },
  }, () => evaluateMcpGate(BENIGN_LEARN));
  assert.equal(result.decision, MCP_GATE_DECISIONS.block);
  assert.deepEqual(result.risk, { level: 'CRITICAL', score: 90, category: 'tool-call' });
});

test('an AB2 block without a risk object keeps the adapter default', () => {
  const result = withStubs({
    ab2: { decision: toolCallGate.TOOL_GATE_DECISIONS.block, reason: 'stubbed_block', canDryRun: false, requiredReview: false },
  }, () => evaluateMcpGate(BENIGN_LEARN));
  assert.equal(result.decision, MCP_GATE_DECISIONS.block);
  assert.equal(result.risk.score, 80);
});

test('an AB4 block reports its 0-1 risk on the 0-100 scale, levelled by that score', () => {
  const result = withStubs({
    ab4: {
      decision: memoryMutationGate.MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      canDryRun: false,
      requiredReview: false,
      risk: { level: 'critical', score: 0.42, categories: ['graph'] },
    },
  }, () => evaluateMcpGate(BENIGN_LEARN));
  assert.equal(result.decision, MCP_GATE_DECISIONS.block);
  assert.deepEqual(result.risk, { level: 'MEDIUM', score: 42, categories: ['graph'] });
});

test('an AB5 block, and the AB5 finding it records, report 0-1 risk on the 0-100 scale, levelled by that score', () => {
  const result = withStubs({
    ab5: {
      decision: automationSafetyGate.AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: 'stubbed_block',
      canDryRun: false,
      requiredReview: false,
      risk: { level: 'critical', score: 0.7, categories: ['force_push'] },
      metadata: { actionId: 'stub' },
    },
  }, () => evaluateMcpGate(BENIGN_AGENT));
  assert.equal(result.decision, MCP_GATE_DECISIONS.block);
  assert.deepEqual(result.risk, { level: 'HIGH', score: 70, categories: ['force_push'] });
  const finding = result.findings.find((item) => item.gate === 'AB5');
  assert.equal(finding.risk.score, 70);
});

test('an AB5 review finding is converted once, not again when the adapter aggregates', () => {
  const result = withStubs({
    ab5: {
      decision: automationSafetyGate.AUTOMATION_SAFETY_DECISIONS.REVIEW,
      reason: 'stubbed_review',
      canDryRun: true,
      requiredReview: true,
      risk: { level: 'medium', score: 0.6, categories: ['automation'] },
      metadata: { actionId: 'stub' },
    },
  }, () => evaluateMcpGate(BENIGN_AGENT));
  const finding = result.findings.find((item) => item.gate === 'AB5');
  assert.equal(finding.risk.score, 60);
  assert.ok(result.risk.score < 100, `a 0.6 finding must not be scaled twice into ${result.risk.score}`);
  assert.ok(result.risk.score >= 60, 'the aggregate keeps the highest finding score');
});
