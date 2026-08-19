'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mcpToolPolicy } = require('../lib/mcp-tool-policy');
const { evaluateToolPolicy } = require('../toolPolicy');
const { classifyMcpTool } = require('../lib/mcp-gate-adapter');
const { MCP_TOOL_SUFFIXES } = require('../lib/mcp-tool-names');

test('a read-only MCP tool is allowed, where toolPolicy alone blocked it', () => {
  // The defect: huqan.plan is gated `allow` by the adapter that runs it, and
  // huqan.policy answered external/block/unknown-tool-blocked at risk 70.
  const before = evaluateToolPolicy({ tool: 'huqan.plan', input: 'x' });
  const after = mcpToolPolicy('huqan.plan');

  assert.equal(before.action, 'block');
  assert.equal(after.action, 'allow');
  assert.equal(after.category, 'internal');
  assert.equal(after.riskScore, 0);
  assert.equal(after.blocked, false);
});

test('a mutating MCP tool reports review, matching the gate that runs it', () => {
  const policy = mcpToolPolicy('huqan.learn');

  assert.equal(policy.action, 'review');
  assert.equal(policy.requiresApproval, true);
  assert.equal(policy.mcp.gateDecision, 'review');
});

test('the agent loop reports dry-run-only over MCP', () => {
  const policy = mcpToolPolicy('huqan.agent');

  assert.equal(policy.action, 'dry_run_only');
  assert.equal(policy.executionMode, 'dry-run');
});

test('a legacy axiom name answers exactly like its canonical spelling', () => {
  assert.deepEqual(
    { ...mcpToolPolicy('axiom.learn'), tool: null },
    { ...mcpToolPolicy('huqan.learn'), tool: null },
  );
});

test('every MCP tool the gate adapter knows gets the gate adapter answer', () => {
  // The expectation is derived from classifyMcpTool rather than restated, so
  // this cannot drift from the authority it exists to agree with. Operator-only
  // visibility is not the same thing as classification: huqan.approvals is
  // withheld from tools/list yet is a read the adapter knows and allows, while
  // huqan.approve and huqan.agent_resume are not classified at all and must
  // keep reaching the fail-closed branch.
  const unclassified = [];

  for (const suffix of MCP_TOOL_SUFFIXES) {
    const name = `huqan.${suffix}`;
    const classification = classifyMcpTool(name);
    const policy = mcpToolPolicy(name);

    if (classification.known !== true) {
      unclassified.push(suffix);
      assert.equal(policy, null, `${name} must fall through to the fail-closed branch`);
      continue;
    }

    assert.ok(policy, `${name} should be answered by the MCP authority`);
    assert.equal(policy.blocked, false, `${name} should not report blocked`);
    assert.equal(policy.action, classification.alphaDecision, `${name} must match the gate`);
  }

  // Named so that a tool silently leaving or joining the classified set shows
  // up here rather than only as a changed policy answer.
  assert.deepEqual(unclassified.sort(), ['agent_resume', 'approve']);
});

test('anything that is not a HUQAN MCP tool falls through', () => {
  // Returning null is what preserves toolPolicy.js's fail-closed handling for
  // unknown and destructive names.
  for (const name of ['learn', 'huqan.notatool', 'axiom.notatool', 'shell.exec', 'browser.open', '']) {
    assert.equal(mcpToolPolicy(name), null, `${name} must fall through`);
  }
});

test('the namespace is not a way to reach an answer a suffix did not earn', () => {
  assert.equal(mcpToolPolicy('huqan.rm -rf /'), null);
  assert.equal(evaluateToolPolicy({ tool: 'huqan.rm -rf /', input: 'x' }).blocked, true);
});
