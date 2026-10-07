'use strict';

// #3498: one vocabulary for agent pause reasons and fractal-learn stop
// reasons, and a ratchet on the drift between each workflow's HTTP request
// schema and its MCP input schema.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
    // #3494: a run that repeats itself without progress.
    'stalled_without_progress',
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

test('no production source sets a pause reason or fractal stop reason as a string literal', () => {
  // Every tracked production source, not a fixed file list: a quoted value
  // assigned (`=`, not `===`) or given as an object key is a second
  // definition. lib/causal has its own traversal stopReason vocabulary.
  const literal = /\b(pauseReason|stopReason)\s*(?:=(?!=)|:)\s*(?:[^;,\n]*\|\|\s*)?['"`]/;
  const sources = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(file => file && !/(^|\/)test\/|\.test\.js$|^lib\/causal\/|^scripts\/|^benchmarks\//.test(file));
  assert.ok(sources.includes('agent.v3.js') && sources.includes('lib/fractal-learn.js'));
  const offenders = [];
  for (const file of sources) {
    read(file).split('\n').forEach((line, index) => {
      if (literal.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
  assert.match(read('lib/experience/run-repair.js'), /REPAIR_PAUSE\s*=\s*AGENT_PAUSE_REASONS\.REPAIR_PENDING_APPROVAL/);
  assert.match(read('agent.v3.js'), /UNCERTAIN_PAUSE\s*=\s*AGENT_PAUSE_REASONS\.EXPERIENCE_EFFECT_UNCERTAIN/);
});

test('the literal check catches assignments and keys, not comparisons', () => {
  const literal = /\b(pauseReason|stopReason)\s*(?:=(?!=)|:)\s*(?:[^;,\n]*\|\|\s*)?['"`]/;
  assert.ok(literal.test("state.pauseReason = 'x';"));
  assert.ok(literal.test("state.pauseReason = state.pauseReason || 'x';"));
  assert.ok(literal.test("return { stopReason: 'x' };"));
  assert.equal(literal.test("if (state.pauseReason === 'x') {"), false);
  assert.equal(literal.test('state.pauseReason = AGENT_PAUSE_REASONS.X;'), false);
  assert.equal(literal.test("pauseReason: { anyOf: [{ type: 'string' }] },"), false);
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
        // Which keywords differ, for the reader; the pair's digest pins the
        // values, so a change inside a field that already drifts is caught too.
        const httpField = normalize(httpProps[key]);
        const mcpField = normalize(mcpProps[key]);
        const keywords = [...new Set([...Object.keys(httpField), ...Object.keys(mcpField)])]
          .filter(word => JSON.stringify(httpField[word]) !== JSON.stringify(mcpField[word]))
          .sort();
        const digest = crypto.createHash('sha256').update(JSON.stringify([httpField, mcpField])).digest('hex').slice(0, 8);
        drift.push(`${key}:differs(${keywords.join(',')}):${digest}`);
      }
    }
    const httpRequired = [...(http.required || [])].sort();
    const mcpRequired = [...((mcp.inputSchema || {}).required || [])].sort();
    if (JSON.stringify(httpRequired) !== JSON.stringify(mcpRequired)) {
      drift.push(`required:${httpRequired.join('|')}!=${mcpRequired.join('|')}`);
    }
    // Root keywords beyond properties/required (additionalProperties, type,
    // ...) constrain the whole input and drift the same way.
    const rootOf = schema => normalize(Object.fromEntries(
      Object.entries(schema || {}).filter(([word]) => word !== 'properties' && word !== 'required'),
    ));
    const httpRoot = rootOf(http);
    const mcpRoot = rootOf(mcp.inputSchema);
    const rootWords = [...new Set([...Object.keys(httpRoot), ...Object.keys(mcpRoot)])]
      .filter(word => JSON.stringify(httpRoot[word]) !== JSON.stringify(mcpRoot[word]))
      .sort();
    if (rootWords.length) {
      const digest = crypto.createHash('sha256').update(JSON.stringify([httpRoot, mcpRoot])).digest('hex').slice(0, 8);
      drift.push(`$root:differs(${rootWords.join(',')}):${digest}`);
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
  ask: [
    'question:differs(maxLength,minLength):998fdd8d', 'workspaceId:http-only',
    'required:question|workspaceId!=question',
  ],
  verify: [
    'claim:http-only', 'statement:mcp-only', 'workspaceId:differs(maxLength):cdd11fe9',
    'required:claim|workspaceId!=statement',
  ],
  advocate: ['claim:differs(minLength):a4b8a8d8', 'workspaceId:differs(const,maxLength,type):38c4c0d4'],
  'learn-review': [
    'maxSentences:mcp-only', 'provenance:differs(additionalProperties,properties):23ee9dd2',
    'skipConflicts:mcp-only', 'sourceRef:http-only', 'sourceTitle:http-only', 'sourceType:http-only',
    'text:differs(maxLength,minLength):cd313fbd', 'workspaceId:differs(maxLength,minLength):9caf1aef',
    'required:text|workspaceId!=text',
  ],
  'approval-decision': ['approvalId:mcp-only', 'workspaceId:mcp-only', 'required:decision!=approvalId|workspaceId'],
  'memory-search': ['query:differs(minLength):1239a2d1', 'workspaceId:differs(minLength):b18eb2c6'],
  'ingest-execute': [
    'alternatives:mcp-only', 'author:mcp-only', 'date:mcp-only', 'decidedBy:mcp-only',
    'idempotencyKey:mcp-only', 'links:mcp-only', 'rationale:mcp-only', 'sourceType:mcp-only', 'text:mcp-only',
    'title:mcp-only', 'workspaceId:mcp-only', 'required:!=sourceType',
    '$root:differs(additionalProperties):9e6cdc68',
  ],
  'agent-plan': [
    'goal:differs(maxLength,minLength):04bf5d9f', 'workspaceId:http-only', 'required:goal|workspaceId!=goal',
  ],
  'agent-run': [
    'goal:differs(maxLength,minLength):04bf5d9f', 'workspaceId:http-only', 'required:goal|workspaceId!=goal',
  ],
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

test('the drift normalizer ignores descriptions and keeps constraint keywords', () => {
  const http = { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 10 }, h: { type: 'string' } } };
  const mcp = { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 20, description: 'x' }, m: { type: 'boolean' } } };
  assert.notDeepEqual(normalize(http.properties.q), normalize(mcp.properties.q));
  assert.deepEqual(normalize({ type: 'string', enum: ['a'], description: 'd' }), normalize({ enum: ['a'] }));
  assert.notDeepEqual(normalize({ type: 'string', enum: ['a'] }), normalize({ enum: ['a', 'b'] }));
});
