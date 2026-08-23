'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MCP_TOOL_CLASSIFICATIONS,
  MCP_GATE_REASONS,
  classifyMcpTool,
} = require('../lib/mcp-gate-adapter');

// A tool's `gates` list is a claim about what actually runs. A gate named here
// and skipped at runtime is worse than an absent one: it reports a protection
// that does not exist. These tests pin the claim to the behaviour in both
// directions -- nothing advertised that does not run, nothing running that is
// not advertised.

test('#1254 no classification advertises a gate the adapter cannot evaluate', () => {
  // Every gate the adapter has an evaluation branch for.
  const EVALUATED_GATES = new Set(['AB1', 'AB2', 'AB4', 'AB5', 'AB8', 'AB9', 'AB11']);

  for (const [tool, classification] of Object.entries(MCP_TOOL_CLASSIFICATIONS)) {
    for (const gate of classification.gates) {
      assert.ok(
        EVALUATED_GATES.has(gate),
        `${tool} advertises ${gate}, which no code path in evaluateMcpGate runs`,
      );
    }
  }
});

test('#1254 AB4 is advertised only by the tool it actually runs for', () => {
  // The AB4 branch used to carry a hardcoded `=== "huqan.learn"` alongside the
  // list check, so ingest_execute could list AB4 and never be evaluated.
  const advertisingAb4 = Object.entries(MCP_TOOL_CLASSIFICATIONS)
    .filter(([, classification]) => classification.gates.includes('AB4'))
    .map(([tool]) => tool);

  assert.deepEqual(advertisingAb4, ['huqan.learn']);

  // ingest_execute keeps the gates that do run for it.
  const ingest = classifyMcpTool('huqan.ingest_execute');
  assert.ok(!ingest.gates.includes('AB4'), 'ingest is admitted by decideIngestApproval, not AB4');
  assert.deepEqual(ingest.gates, ['AB1', 'AB2', 'AB11']);
  assert.equal(ingest.mutating, true, 'dropping the false claim must not declassify the tool');
  assert.equal(ingest.alphaDecision, 'review');
});

test('#1253 AB6 leaves no scaffolding behind that implies it runs', () => {
  // The module was imported and an input builder written while no code path
  // called them, so the control looked present and was dead. Removing it is the
  // recorded decision; these assertions keep the two states from drifting back
  // apart -- either AB6 is wired up and advertised, or neither.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(MCP_GATE_REASONS, 'AB6_BLOCKED'),
    'an unreachable AB6 reason implies a gate that does not exist',
  );

  const advertisingAb6 = Object.entries(MCP_TOOL_CLASSIFICATIONS)
    .filter(([, classification]) => classification.gates.includes('AB6'))
    .map(([tool]) => tool);
  assert.deepEqual(advertisingAb6, []);

  const source = require('node:fs').readFileSync(require.resolve('../lib/mcp-gate-adapter'), 'utf8');
  // The require, not any mention: the docblock names the module deliberately,
  // to record where sandbox isolation would belong if it is ever enforced.
  assert.ok(
    !/require\(['"]\.\/sandbox-isolation['"]\)/.test(source),
    'the dead import must not come back on its own',
  );
  assert.ok(!/buildAb6Input/.test(source), 'the dead input builder must not come back on its own');
});

test('#1183 the operator-token path records that the gates were not consulted', () => {
  const source = require('node:fs').readFileSync(require.resolve('../mcpServer'), 'utf8');

  // The old reason read `operator_authorized` beside `decision: 'allow'`, which
  // is indistinguishable from a verdict the gates produced.
  assert.ok(
    !/reason: 'operator_authorized'/.test(source),
    'a bare operator_authorized reason reads as a gate verdict',
  );
  assert.ok(
    /operator_authorized_gates_not_evaluated/.test(source),
    'the receipt must say the gates were skipped',
  );
  assert.ok(/gatesEvaluated: false/.test(source));

  // agent_resume is not an approval operation, and its refusal said it was.
  assert.ok(
    /required to resume an agent run/.test(source),
    'agent_resume must not borrow the approval handler error text',
  );
});
