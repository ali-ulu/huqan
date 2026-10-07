'use strict';

// #3498: one vocabulary for agent pause reasons and fractal-learn stop
// reasons, and a ratchet on the drift between each workflow's HTTP request
// schema and its MCP input schema.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { AGENT_PAUSE_REASONS, FRACTAL_LEARN_STOP_REASONS } = require('../lib/agent-exit-reasons');
const { FRACTAL_LEARN_DATA_SCHEMA } = require('../lib/mcp-tool-data-schemas-knowledge');
const { REPAIR_PAUSE } = require('../lib/experience/run-repair');
const workflowContract = require('../lib/workflow-contract');
const { TOOL_SCHEMAS } = require('../lib/mcp-tool-catalog');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the vocabularies keep their published values', () => {
  assert.deepEqual(Object.values(AGENT_PAUSE_REASONS), [
    'time_budget_exceeded', 'budget_or_iteration_limit', 'repair_pending_approval', 'experience_effect_uncertain',
  ]);
  assert.deepEqual(Object.values(FRACTAL_LEARN_STOP_REASONS), ['exhausted', 'saturated', 'maxRounds']);
  assert.ok(Object.isFrozen(AGENT_PAUSE_REASONS) && Object.isFrozen(FRACTAL_LEARN_STOP_REASONS));
  assert.equal(REPAIR_PAUSE, AGENT_PAUSE_REASONS.REPAIR_PENDING_APPROVAL);
});

test('the fractal-learn schema declares the producer vocabulary, not a copy', () => {
  assert.deepEqual(FRACTAL_LEARN_DATA_SCHEMA.properties.stopReason.enum, Object.values(FRACTAL_LEARN_STOP_REASONS));
  // Equal values could still be a hand-written copy; the source must derive it.
  assert.match(read('lib/mcp-tool-data-schemas-knowledge.js'), /enum: Object\.values\(FRACTAL_LEARN_STOP_REASONS\)/);
});

test('no producer assigns a pause or stop reason as a bare string', () => {
  // Every place that sets one of these reasons, read as source: a quoted
  // literal on the right-hand side is a second definition.
  const producers = {
    'agent.v3.js': /pauseReason\s*=\s*[^;]*/g,
    'lib/agent-v3-status-methods.js': /pauseReason\s*=\s*[^;]*/g,
    'lib/fractal-learn.js': /stopReason\s*=\s*[^;]*/g,
  };
  for (const [file, pattern] of Object.entries(producers)) {
    const assignments = read(file).match(pattern) || [];
    assert.ok(assignments.length > 0, `${file} still sets a reason`);
    for (const assignment of assignments) {
      assert.ok(!/['"`]/.test(assignment), `${file}: ${assignment.trim()} restates a reason`);
    }
  }
  assert.match(read('lib/experience/run-repair.js'), /REPAIR_PAUSE = AGENT_PAUSE_REASONS\.REPAIR_PENDING_APPROVAL;/);
  assert.match(read('agent.v3.js'), /UNCERTAIN_PAUSE = AGENT_PAUSE_REASONS\.EXPERIENCE_EFFECT_UNCERTAIN;/);
});

// A description, or `type: 'string'` beside a string enum, does not change
// what a schema accepts; everything else does.
function normalize(schema) {
  if (Array.isArray(schema)) return schema.map(normalize);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) if (key !== 'description') out[key] = normalize(value);
  if (Array.isArray(out.enum) && out.enum.every(item => typeof item === 'string') && out.type === 'string') delete out.type;
  return out;
}

function schemaDivergence() {
  const byName = new Map(TOOL_SCHEMAS.map(tool => [tool.name, tool]));
  const result = {};
  for (const workflow of workflowContract.publicWorkflowManifest().workflows) {
    const http = workflowContract.httpRequestSchemaForWorkflow(workflow.workflowId);
    const mcp = workflow.mcpTool && byName.get(workflow.mcpTool);
    if (!http || !mcp) continue;
    const httpProps = http.properties || {};
    const mcpProps = (mcp.inputSchema || {}).properties || {};
    const drift = [];
    for (const key of [...new Set([...Object.keys(httpProps), ...Object.keys(mcpProps)])].sort()) {
      if (!(key in mcpProps)) drift.push(`${key}:http-only`);
      else if (!(key in httpProps)) drift.push(`${key}:mcp-only`);
      else if (JSON.stringify(normalize(httpProps[key])) !== JSON.stringify(normalize(mcpProps[key]))) {
        // The pair's digest pins what differs, so a change inside a field
        // that already drifts is caught too.
        const pair = JSON.stringify([normalize(httpProps[key]), normalize(mcpProps[key])]);
        drift.push(`${key}:differs:${crypto.createHash('sha256').update(pair).digest('hex').slice(0, 8)}`);
      }
    }
    const httpRequired = [...(http.required || [])].sort();
    const mcpRequired = [...((mcp.inputSchema || {}).required || [])].sort();
    if (JSON.stringify(httpRequired) !== JSON.stringify(mcpRequired)) {
      drift.push(`required:${httpRequired.join('|')}!=${mcpRequired.join('|')}`);
    }
    if (drift.length) result[workflow.workflowId] = drift;
  }
  return result;
}

// Recorded on main at #3498. Aligning any of these narrows or renames a
// published input on one surface, which the API Contract gate treats as
// breaking (major release); the decision is tracked separately. A workflow
// with no HTTP schema of its own derives it from the MCP input schema and
// cannot drift.
const KNOWN_SCHEMA_DIVERGENCE = Object.freeze({
  'web-research': ['maxSnippet:http-only', 'summarize:http-only'],
  ask: ['question:differs:998fdd8d', 'workspaceId:http-only', 'required:question|workspaceId!=question'],
  verify: [
    'claim:http-only', 'statement:mcp-only', 'workspaceId:differs:cdd11fe9',
    'required:claim|workspaceId!=statement',
  ],
  advocate: ['claim:differs:a4b8a8d8', 'workspaceId:differs:38c4c0d4'],
  'learn-review': [
    'maxSentences:mcp-only', 'provenance:differs:23ee9dd2', 'skipConflicts:mcp-only', 'sourceRef:http-only',
    'sourceTitle:http-only', 'sourceType:http-only', 'text:differs:cd313fbd', 'workspaceId:differs:9caf1aef',
    'required:text|workspaceId!=text',
  ],
  'approval-decision': ['approvalId:mcp-only', 'workspaceId:mcp-only', 'required:decision!=approvalId|workspaceId'],
  'memory-search': ['query:differs:1239a2d1', 'workspaceId:differs:b18eb2c6'],
  'ingest-execute': [
    'alternatives:mcp-only', 'author:mcp-only', 'date:mcp-only', 'decidedBy:mcp-only',
    'idempotencyKey:mcp-only', 'links:mcp-only', 'rationale:mcp-only', 'sourceType:mcp-only', 'text:mcp-only',
    'title:mcp-only', 'workspaceId:mcp-only', 'required:!=sourceType',
  ],
  'agent-plan': ['goal:differs:04bf5d9f', 'workspaceId:http-only', 'required:goal|workspaceId!=goal'],
  'agent-run': ['goal:differs:04bf5d9f', 'workspaceId:http-only', 'required:goal|workspaceId!=goal'],
});

test('HTTP and MCP input schemas drift only where already recorded', () => {
  const live = schemaDivergence();
  for (const [workflowId, drift] of Object.entries(live)) {
    assert.deepEqual(drift, KNOWN_SCHEMA_DIVERGENCE[workflowId] || [],
      `${workflowId}: new drift between its HTTP and MCP input schemas`);
  }
  for (const workflowId of Object.keys(KNOWN_SCHEMA_DIVERGENCE)) {
    assert.ok(Object.hasOwn(live, workflowId),
      `${workflowId} no longer drifts: remove it from KNOWN_SCHEMA_DIVERGENCE`);
  }
});

test('the drift normalizer ignores descriptions and keeps every constraint', () => {
  const http = { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 10 }, h: { type: 'string' } } };
  const mcp = { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 20, description: 'x' }, m: { type: 'boolean' } } };
  assert.notDeepEqual(normalize(http.properties.q), normalize(mcp.properties.q));
  assert.deepEqual(normalize({ type: 'string', enum: ['a'], description: 'd' }), normalize({ enum: ['a'] }));
  assert.notDeepEqual(normalize({ type: 'string', enum: ['a'] }), normalize({ enum: ['a', 'b'] }));
});
