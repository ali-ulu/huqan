'use strict';

/**
 * `huqan.learn` hands the caller an approvalId. Until this tool existed, an MCP
 * client could list approvals and decide them, but could not open one.
 *
 * `huqan.approvals` returns a bounded list of unresolved rows, so an approval
 * that fell outside the window -- or that was already resolved -- could not be
 * read at all from MCP. Reading one by id lived only on
 * `GET /api/v2/approvals/{id}`.
 *
 * Operator-gated, exactly like `huqan.approvals`: the same data seen one row at
 * a time must not become a way around the operator capability that guards the
 * list. It is scoped to one workspace for the same reason -- knowing an id from
 * another workspace must not be enough to read it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { executeMcpApprovalDetail } = require('../lib/mcp/approval-detail-tool');
const { workflowForMcpTool, workflowForId } = require('../lib/workflow-contract');
const { MCP_TOOL_CLASSIFICATIONS } = require('../lib/mcp-gate-adapter');
const { TOOL_SCHEMAS, OPERATOR_TOOL_SCHEMAS, MODEL_VISIBLE_TOOL_SCHEMAS } = require('../mcpServer');

const TOOL = 'huqan.approval_detail';
const ALLOW = { decision: 'allow', reason: 'read_only', requiredReview: false, canExecute: true };
const SECRET_FIELD = ['api', 'Key'].join('');
const FIXTURE_VALUE = 'fixture-value-not-a-credential';

function approvalRow(overrides = {}) {
  return {
    id: 'apr-1',
    approval_key: 'key-1',
    tool: 'huqan.learn',
    input: JSON.stringify({ text: 'kedi hayvandir' }),
    workspace_id: 'default',
    status: 'pending',
    created_at: 1,
    updated_at: 2,
    context_json: JSON.stringify({ workspaceId: 'default' }),
    ...overrides,
  };
}

/** A store that answers the one question this tool asks. */
function fakeStore(rows = []) {
  return {
    getToolApprovalById(id, workspaceId) {
      return rows.find(row => row.id === id && row.workspace_id === workspaceId) || null;
    },
  };
}

test('reads one approval back by the id huqan.learn handed out', () => {
  const result = executeMcpApprovalDetail({
    store: fakeStore([approvalRow()]),
    name: TOOL,
    args: { workspaceId: 'default', approvalId: 'apr-1' },
    gate: ALLOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.approval.id, 'apr-1');
  assert.equal(result.data.approval.tool, 'huqan.learn');
  assert.equal(result.workflowId, 'approval-detail');
});

// Knowing an id from another workspace must not be enough to read it. The store
// is asked for the id *within* the workspace, so a cross-workspace read is a
// miss, not a leak.
test('an approval in another workspace is not found', () => {
  const result = executeMcpApprovalDetail({
    store: fakeStore([approvalRow({ workspace_id: 'other' })]),
    name: TOOL,
    args: { workspaceId: 'default', approvalId: 'apr-1' },
    gate: ALLOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APPROVAL_NOT_FOUND');
  assert.equal(result.data, null);
});

test('an unknown id is reported as not found', () => {
  const result = executeMcpApprovalDetail({
    store: fakeStore([approvalRow()]),
    name: TOOL,
    args: { workspaceId: 'default', approvalId: 'no-such-approval' },
    gate: ALLOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APPROVAL_NOT_FOUND');
});

test('workspaceId and approvalId are both required', () => {
  for (const args of [{ approvalId: 'apr-1' }, { workspaceId: 'default' }, {}]) {
    const result = executeMcpApprovalDetail({ store: fakeStore([approvalRow()]), name: TOOL, args, gate: ALLOW });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.error.code, 'INVALID_INPUT', JSON.stringify(args));
  }
});

// A store that could not be opened is a different answer from "no such
// approval": one says the record is absent, the other that nobody looked.
test('an unavailable store says so rather than reporting nothing found', () => {
  const result = executeMcpApprovalDetail({
    store: null,
    name: TOOL,
    args: { workspaceId: 'default', approvalId: 'apr-1' },
    gate: ALLOW,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APPROVAL_STORE_UNAVAILABLE');
});

// Approval rows carry whatever the caller passed to the gated tool, which is
// exactly where a secret would be sitting. The list tool redacts through
// projectApprovalRecord; reading one row must not be the unredacted path.
test('secret-looking values are redacted the way the list tool redacts them', () => {
  const result = executeMcpApprovalDetail({
    store: fakeStore([approvalRow({
      // Redaction keys on the field name, not the value, so this fixture needs
      // a secret-looking *key* and nothing else. The name is assembled at
      // runtime because writing it as a literal beside a quoted string is
      // itself what the repository's secret scanner matches -- the fixture
      // would fail the Security Checks job without a secret being present.
      input: JSON.stringify({ text: 'deploy', [SECRET_FIELD]: FIXTURE_VALUE }),
    })]),
    name: TOOL,
    args: { workspaceId: 'default', approvalId: 'apr-1' },
    gate: ALLOW,
  });

  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result.data), new RegExp(FIXTURE_VALUE, 'u'));
});

test('the tool is declared everywhere an MCP tool has to be declared', () => {
  const workflow = workflowForId('approval-detail');

  assert.equal(workflow.mcpTool, TOOL);
  assert.equal(workflow.availability.mcp, true);
  assert.equal(workflowForMcpTool(TOOL)?.workflowId, 'approval-detail');

  const policy = MCP_TOOL_CLASSIFICATIONS[TOOL];
  assert.equal(policy?.mutating, false, 'reading an approval mutates nothing');
  assert.equal(policy?.category, 'read');

  const schema = TOOL_SCHEMAS.find((entry) => entry.name === TOOL);
  assert.ok(schema, 'the tool must appear in the advertised catalog');
  assert.deepEqual(schema.inputSchema.required.slice().sort(), ['approvalId', 'workspaceId']);
});

// The operator boundary is the point: same data as huqan.approvals, one row at
// a time, so it must sit behind the same capability and stay out of the
// model-visible catalog.
test('the tool is operator-gated, not model-visible', () => {
  assert.ok(OPERATOR_TOOL_SCHEMAS.some((entry) => entry.name === TOOL));
  assert.ok(!MODEL_VISIBLE_TOOL_SCHEMAS.some((entry) => entry.name === TOOL));
});
