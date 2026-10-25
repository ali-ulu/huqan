'use strict';

// #4229: the MCP gate classified `huqan.web_research` as a read-only tool, so
// the call that opens pending candidates -- which writes durable candidate rows
// through `kernel.addCandidateClaim` -- was recorded as `read_only_allow` and
// ran without a human in the loop. The classification now follows the call:
// the shape that writes is classified as a write and routed through the gate's
// mutation path, while a plain research call stays a read.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  MCP_GATE_REASONS,
  classifyMcpTool,
  evaluateMcpGate,
} = require('../lib/mcp-gate-adapter');

const RESEARCH_ARGS = Object.freeze({
  workspaceId: 'default',
  provider: 'tavily',
  query: 'engine operating limit',
});

test('#4229 a web-research call that opens no candidate is still read-only', () => {
  const classification = classifyMcpTool('huqan.web_research', RESEARCH_ARGS);

  assert.equal(classification.known, true);
  assert.equal(classification.mutating, false);
  assert.equal(classification.category, 'read');
  assert.equal(classification.alphaDecision, 'allow');
});

test('#4229 the candidate-opening call shape is classified as a write', () => {
  const classification = classifyMcpTool('huqan.web_research', { ...RESEARCH_ARGS, openCandidates: true });

  assert.equal(classification.mutating, true);
  assert.equal(classification.category, 'write');
  assert.equal(classification.alphaDecision, 'review');
  assert.deepEqual([...classification.gates].sort(), ['AB1', 'AB11', 'AB2', 'AB9']);
  assert.ok(!classification.gates.includes('AB4'), 'AB4 is the memory-mutation gate only huqan.learn runs');
});

test('#4229 the gate answers HUMAN_REVIEW / HIGH for the candidate-opening call', () => {
  const gate = evaluateMcpGate({
    tool: 'huqan.web_research',
    args: { ...RESEARCH_ARGS, openCandidates: true },
    metadata: {},
  });

  assert.equal(gate.decision, 'review');
  assert.equal(gate.reason, MCP_GATE_REASONS.MUTATING_REVIEW);
  assert.equal(gate.canExecute, false);
  assert.equal(gate.requiredReview, true);
  assert.equal(gate.risk.category, 'write');
  assert.equal(gate.metadata.mutating, true);

  // The action risk classifier sees the call as a graph write: HUMAN_REVIEW at
  // HIGH. The aggregate score is that 80 on the canonical 0-100 scale; the
  // reported level is the band the score falls in (lib/risk-scale.js).
  const ab1 = gate.findings.find((finding) => finding.gate === 'AB1');
  assert.equal(ab1.decision, 'HUMAN_REVIEW');
  assert.equal(ab1.riskLevel, 'HIGH');
  assert.equal(gate.risk.score, 80);
});

test('#4229 the plain research call is still allowed and low risk', () => {
  const gate = evaluateMcpGate({
    tool: 'huqan.web_research',
    args: RESEARCH_ARGS,
    metadata: {},
  });

  assert.equal(gate.decision, 'allow');
  assert.equal(gate.reason, MCP_GATE_REASONS.READ_ONLY_ALLOW);
  assert.equal(gate.canExecute, true);
  assert.equal(gate.risk.level, 'LOW');
  assert.equal(gate.metadata.mutating, false);
});

test('#4229 only the boolean true opens candidates, so only it is gated as a write', () => {
  // The workflow's own predicate: anything but the boolean true opens no
  // candidate, so the gate must not call such a call a write either.
  const source = fs.readFileSync(require.resolve('../lib/web-research-workflow'), 'utf8');
  assert.ok(source.includes('input.openCandidates === true'), 'the workflow opens candidates only on the boolean true');

  for (const value of ['true', 1, 'yes', {}]) {
    const classification = classifyMcpTool('huqan.web_research', { ...RESEARCH_ARGS, openCandidates: value });
    assert.equal(classification.mutating, false, `openCandidates=${JSON.stringify(value)} opens no candidate`);
    assert.equal(classification.category, 'read');
  }
});

test('#4229 the legacy alias is gated identically', () => {
  const canonical = classifyMcpTool('huqan.web_research', { ...RESEARCH_ARGS, openCandidates: true });
  const legacy = classifyMcpTool('axiom.web_research', { ...RESEARCH_ARGS, openCandidates: true });

  assert.deepEqual(legacy, canonical);
});

test('#4229 an MCP candidate-opening call is queued for review and writes no candidate', async () => {
  const { callTool } = require('../mcpServer');
  const writes = [];
  const kernel = {
    addCandidateClaim: (...args) => {
      writes.push(args);
      return { candidateId: 'cand_1' };
    },
    graph: { getAllEdges: () => [] },
    recordGateDecision: () => {},
  };
  const saved = [];
  const approvalStore = {
    saveToolApproval: (approval) => {
      saved.push(approval);
      return approval;
    },
    listUnresolvedToolApprovals: () => [],
    countPendingToolApprovals: () => 0,
    countUnresolvedToolApprovals: () => 0,
    getToolApprovalById: () => null,
  };

  const output = await callTool(kernel, {
    name: 'huqan.web_research',
    arguments: { ...RESEARCH_ARGS, openCandidates: true },
  }, { approvalStore });

  assert.equal(output.ok, false);
  assert.equal(output.policy.decision, 'review');
  assert.equal(output.policy.reason, MCP_GATE_REASONS.MUTATING_REVIEW);
  assert.equal(output.gate.decision, 'review');
  assert.match(output.message, /queued for review/);
  assert.equal(saved.length, 1, 'the call is queued for a human');
  assert.equal(saved[0].tool, 'huqan.web_research');
  assert.equal(writes.length, 0, 'no candidate row is written before a human decides');
});
