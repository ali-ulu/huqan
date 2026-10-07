'use strict';

// Declared external-agent origin on the approval surface (#2592).
//
// An MCP call carries no caller identity, so an instruction that declares
// external-agent origin (provenance.sourceType 'agent') must be visible as
// such on every approval screen, and must never execute on synthesized
// provenance alone.

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildApprovalAdmissionOptions } = require('../lib/mcp-approval-admission');
const { projectApprovalRecord } = require('../lib/mcp-approval-views');
const { buildMcpOversightInput } = require('../lib/mcp-human-oversight-adapter');
const { ProvenanceError } = require('../lib/errors/provenance-error');

function approvalWithProvenance(provenance) {
  return {
    id: 'a1',
    tool: 'huqan.learn',
    input: JSON.stringify({ text: 'cats are animals' }),
    workspace_id: 'w',
    status: 'pending',
    // A real pending row always carries created_at; without it #3486 now reads
    // the row as an expired legacy row and refuses the approval first.
    created_at: Date.now(),
    context: { workspaceId: 'w', args: { text: 'cats are animals' }, provenance },
  };
}

test('the projection labels declared agent origin and never claims locality', () => {
  const external = projectApprovalRecord(approvalWithProvenance({ sourceType: 'agent', actor: 'agent:eve' }));
  assert.deepEqual(external.origin, { kind: 'external-agent', ref: 'agent:eve' });

  const fallback = projectApprovalRecord(approvalWithProvenance({ sourceType: 'agent' }));
  assert.deepEqual(fallback.origin, { kind: 'external-agent', ref: 'unknown' });

  const plain = projectApprovalRecord(approvalWithProvenance({ sourceType: 'api', actor: 'mcp.learn' }));
  assert.deepEqual(plain.origin, { kind: 'unknown', ref: null });

  const missing = projectApprovalRecord(approvalWithProvenance(undefined));
  assert.deepEqual(missing.origin, { kind: 'unknown', ref: null });
});

test('admission flags unproven agent origin and nothing else', () => {
  const unproven = buildApprovalAdmissionOptions(
    { id: 'a1', context: { workspaceId: 'w', provenance: { sourceType: 'agent' } } }, {},
  );
  assert.equal(unproven.agentOriginUnproven, true);

  const proven = buildApprovalAdmissionOptions(
    { id: 'a1', context: { workspaceId: 'w', provenance: { sourceType: 'agent', provenanceId: 'prov_x', sourceRef: 'a2a:route:1' } } }, {},
  );
  assert.equal(proven.agentOriginUnproven, false);

  const ordinary = buildApprovalAdmissionOptions({ id: 'a1', context: { workspaceId: 'w' } }, {});
  assert.equal(ordinary.agentOriginUnproven, false);
  assert.equal(ordinary.sourceType, 'api');
});

function oversightArgsFor(stored) {
  return {
    approval: { id: 'a1', approvalKey: 'k1', tool: 'huqan.learn', context: stored.context },
    toolName: 'huqan.learn',
    storedArgs: { text: 'cats are animals', workspaceId: 'w' },
    gate: {},
    runtime: {},
  };
}

test('an unproven agent-origin instruction gets no oversight case', () => {
  const stored = approvalWithProvenance({ sourceType: 'agent', actor: 'agent:eve' });
  assert.throws(
    () => buildMcpOversightInput(oversightArgsFor(stored)),
    (error) => error instanceof ProvenanceError && /provenanceId and sourceRef/.test(error.message),
  );
});

test('a proven agent-origin instruction builds its oversight input', () => {
  const stored = approvalWithProvenance({ sourceType: 'agent', actor: 'agent:eve', provenanceId: 'prov_x', sourceRef: 'a2a:route:1' });
  const input = buildMcpOversightInput(oversightArgsFor(stored));
  assert.ok(input.caseId);
  assert.equal(input.action.workspaceId, 'w');
});

function decisionHarness(stored) {
  const { createMcpApprovalDecisionHandler } = require('../lib/mcp-approval-decision-handler');
  const fail = (code, message, extra) => ({ ok: false, error: { code, message }, ...extra });
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  return handle(
    { learn: () => { throw new Error('must not execute without provenance'); } },
    { approvalId: 'a1', workspaceId: 'w', decision: 'approved' },
    {
      approvalStore: {
        getToolApprovalById: () => stored,
        claimToolApproval: () => ({ claimed: true }),
        rejectToolApproval: () => null,
        failToolApproval: () => null,
        finalizeToolApprovalWithReceipt: () => null,
      },
    },
  );
}

test('an unproven agent-origin instruction never executes, oversight or not', () => {
  const stored = approvalWithProvenance({ sourceType: 'agent', actor: 'agent:eve' });
  const result = decisionHarness(stored);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AGENT_ORIGIN_PROVENANCE_REQUIRED');
});

test('a proven agent-origin instruction passes the execution gate', () => {
  const stored = approvalWithProvenance({ sourceType: 'agent', actor: 'agent:eve', provenanceId: 'prov_x', sourceRef: 'a2a:route:1' });
  const result = decisionHarness(stored);
  assert.notEqual(result.error && result.error.code, 'AGENT_ORIGIN_PROVENANCE_REQUIRED');
});
