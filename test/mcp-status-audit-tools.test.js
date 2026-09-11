'use strict';

/**
 * Two read-only capabilities that only the CLI could reach, and the guard that
 * keeps the next one from appearing unnoticed.
 *
 * `system-status` and `compliance-audit` were declared `mutation: false` with
 * `availability: { cli: true }` and nothing else. An operator working through an
 * MCP client could not ask what state the graph was in, or read the EU AI Act
 * report -- the two questions most likely to be asked *about* a run that just
 * happened in that same client.
 *
 * The last test is the point of this file. Three separate pull requests found
 * missing MCP surfaces one at a time by reading the contract by hand; this turns
 * that into a failing test, with exemptions named and justified in one place
 * rather than discovered one at a time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { executeMcpSystemStatus } = require('../lib/mcp/system-status-tool');
const { executeMcpComplianceAudit } = require('../lib/mcp/compliance-audit-tool');
const { buildSystemStatus, formatSystemStatusText } = require('../lib/system-status-report');
const { WORKFLOW_CAPABILITIES, workflowForId } = require('../lib/workflow-contract');
const { MCP_TOOL_CLASSIFICATIONS } = require('../lib/mcp-gate-adapter');
const { TOOL_SCHEMAS, MODEL_VISIBLE_TOOL_SCHEMAS } = require('../mcpServer');
const KernelV2 = require('../index.js');

const ALLOW = { decision: 'allow', reason: 'read_only', requiredReview: false, canExecute: true };

function scratchKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-status-audit-'));
  const kernel = new KernelV2({ dbPath: path.join(dir, 'memory.db') });
  kernel.learn('kedi hayvandir');
  return kernel;
}

test('system status answers with counts, not with a formatted CLI string', () => {
  const result = executeMcpSystemStatus({
    kernel: scratchKernel(), name: 'huqan.status', args: {}, gate: ALLOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.workflowId, 'system-status');
  assert.equal(typeof result.data.nodes, 'number');
  assert.equal(typeof result.data.edges, 'number');
  assert.equal(typeof result.data.entropy, 'number');
  assert.ok(Array.isArray(result.data.gaps));
  assert.ok(Array.isArray(result.data.contradictions));
  // An MCP client gets data it can act on. Handing it the CLI's printed line
  // would make the model parse prose to find a number it should have been given.
  assert.equal(typeof result.data.text, 'undefined');
});

// The CLI and the tool must not drift into two different answers, so they read
// the same report; the CLI is the one that formats it.
test('the CLI text is a rendering of the same report the tool returns', () => {
  const kernel = scratchKernel();
  const report = buildSystemStatus(kernel);
  const text = formatSystemStatusText(report);

  assert.match(text, new RegExp(`${report.nodes} nodes`, 'u'));
  assert.match(text, new RegExp(`${report.edges} edges`, 'u'));
  assert.match(text, /entropy/u);
});

test('the compliance audit returns the report the CLI builds', () => {
  const result = executeMcpComplianceAudit({
    kernel: scratchKernel(), name: 'huqan.audit', args: { workspaceId: 'default' }, gate: ALLOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.workflowId, 'compliance-audit');
  assert.equal(result.data.schemaVersion, 'huqan-audit-report-v1');
  assert.ok(result.data.articles.art12_record_keeping, 'Art 12 must be reported');
  assert.ok(result.data.articles.art13_transparency);
  assert.ok(result.data.articles.art14_human_oversight);
});

test('both tools are declared everywhere an MCP tool has to be declared', () => {
  for (const [workflowId, tool] of [['system-status', 'huqan.status'], ['compliance-audit', 'huqan.audit']]) {
    const workflow = workflowForId(workflowId);
    assert.equal(workflow.mcpTool, tool, workflowId);
    assert.equal(workflow.availability.mcp, true, workflowId);

    const policy = MCP_TOOL_CLASSIFICATIONS[tool];
    assert.equal(policy?.mutating, false, tool);
    assert.equal(policy?.category, 'read', tool);

    const schema = TOOL_SCHEMAS.find((entry) => entry.name === tool);
    assert.ok(schema, `${tool} must appear in the advertised catalog`);
    assert.equal(schema.annotations.readOnlyHint, true, tool);
    // Read-only and harmless, so unlike the approval tools these stay visible
    // to the model: asking "what state is the graph in" is the ordinary case.
    assert.ok(MODEL_VISIBLE_TOOL_SCHEMAS.some((entry) => entry.name === tool), tool);
  }
});

/**
 * Exemptions, each with the reason it is not an oversight.
 *
 * An entry here is a claim that the capability *should not* have an MCP
 * surface. Adding one is a decision that shows up in review; leaving a new
 * read-only workflow out of both this map and the MCP catalog fails the test
 * below.
 */
const NO_MCP_SURFACE_ON_PURPOSE = Object.freeze({
  quickstart: 'an interactive first-run setup flow; it walks an operator through '
    + 'local configuration and has nothing to return to a programmatic caller',
  hypotheses: 'its --propose/--review paths write, so the read-only declaration '
    + 'is partial; huqan.dream is the MCP surface for hypothesis generation',
  recommendation: 'the LLM recommendation path needs a provider key the MCP '
    + 'server deliberately does not carry',
});

test('a read-only capability reachable from a human surface is reachable from MCP', () => {
  const missing = WORKFLOW_CAPABILITIES
    .filter((workflow) => workflow.mutation !== true)
    .filter((workflow) => {
      const availability = workflow.availability || {};
      return availability.api === true || availability.cli === true || availability.ui === true;
    })
    .filter((workflow) => !workflow.mcpTool)
    .map((workflow) => workflow.workflowId)
    .filter((workflowId) => !Object.hasOwn(NO_MCP_SURFACE_ON_PURPOSE, workflowId));

  assert.deepEqual(missing, [],
    'these read-only capabilities can be reached by a person but not by an MCP client.\n'
    + 'Give each one a tool, or add it to NO_MCP_SURFACE_ON_PURPOSE with the reason:\n  '
    + missing.join('\n  '));
});

// An exemption whose capability no longer exists is a stale claim, and a reason
// short enough to be a label is not a reason.
test('every exemption names a real capability and states why', () => {
  for (const [workflowId, reason] of Object.entries(NO_MCP_SURFACE_ON_PURPOSE)) {
    assert.ok(workflowForId(workflowId), `${workflowId} is exempted but not in the contract`);
    assert.ok(reason.length > 40, `${workflowId}: needs a reason, not a label`);
  }
});
