'use strict';

// Characterization for #2207: the oversight-case helpers living in
// lib/mcp-approval-decision-handler.js must behave identically after moving
// to lib/mcp-human-oversight-adapter.js. Written BEFORE the move (imports
// from the handler); the move only rewires the import source.

const assert = require('node:assert/strict');
const test = require('node:test');

// #2207: import source moved to ../lib/mcp-human-oversight-adapter.
// Behaviour pinned here must not change across the move.
const {
  getHumanOversightRuntime,
  createMcpOversightCase,
} = require('../lib/mcp-human-oversight-adapter');

function fullRuntime() {
  return {
    humanOversightApprovalRuntime: {
      createReviewCase: () => ({ ok: true, case: { caseId: 'c1', status: 'pending' } }),
      getReviewCase: () => ({ ok: true, case: { caseId: 'c1', status: 'pending' } }),
      decide: () => ({ ok: true }),
      executeApproved: () => ({ ok: true }),
    },
  };
}

const approval = {
  id: 'a1',
  approvalKey: 'k1',
  tool: 'huqan.learn',
  context: { workspaceId: 'w', args: { text: 'x' } },
};

test('getHumanOversightRuntime passes a complete runtime, rejects fragments', () => {
  assert.equal(getHumanOversightRuntime({}), null);
  assert.equal(getHumanOversightRuntime({ humanOversightApprovalRuntime: { createReviewCase() {} } }), null);
  assert.equal(getHumanOversightRuntime(fullRuntime()) !== null, true);
});

test('createMcpOversightCase stays disabled without a runtime or for other tools', () => {
  assert.deepEqual(
    createMcpOversightCase({ runtime: {}, approval, toolName: 'huqan.learn', storedArgs: {}, gate: {} }),
    { enabled: false, ok: true },
  );
  assert.deepEqual(
    createMcpOversightCase({ runtime: fullRuntime(), approval, toolName: 'huqan.agent', storedArgs: {}, gate: {} }),
    { enabled: false, ok: true },
  );
});

test('createMcpOversightCase opens a huqan.learn case with a full runtime', () => {
  const result = createMcpOversightCase({ runtime: fullRuntime(), approval, toolName: 'huqan.learn', storedArgs: { text: 'x' }, gate: {} });
  assert.equal(result.enabled, true);
  assert.equal(result.ok, true);
  assert.equal(result.input.caseId, 'mcp-oversight:a1');
  assert.equal(result.result.case.caseId, 'c1');
});
