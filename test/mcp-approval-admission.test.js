'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildApprovalAdmissionOptions } = require('../lib/mcp-approval-admission');

const baseApproval = () => ({
  id: 'approval-123',
  approvalKey: 'key-abc',
  context: {
    workspaceId: 'ws-primary',
    candidateId: 'cand-1',
  },
});

test('buildApprovalAdmissionOptions pins the approval identity onto the admission', () => {
  const options = buildApprovalAdmissionOptions(baseApproval(), {});
  assert.equal(options.approvalRequired, true);
  assert.equal(options.approvalStatus, 'approved');
  assert.equal(options.approvalId, 'approval-123');
  assert.equal(options.workspaceId, 'ws-primary');
  assert.equal(options.candidateId, 'cand-1');
  assert.equal(options.memoryDraftId, 'cand-1');
  assert.equal(options.provenanceId, 'prov_mcp_approval-123');
  assert.equal(options.admissionContext.approvalId, 'approval-123');
  assert.equal(options.admissionContext.workspaceId, 'ws-primary');
});

test('workspace scope resolves through the documented fallback chain and never becomes empty', () => {
  // context.workspaceId wins over candidate and args.
  const approval = baseApproval();
  approval.context.candidate = { workspaceId: 'ws-candidate' };
  assert.equal(buildApprovalAdmissionOptions(approval, { workspaceId: 'ws-args' }).workspaceId, 'ws-primary');

  // Falls to candidate.workspaceId, then args.workspaceId, then 'default'.
  const withCandidate = baseApproval();
  delete withCandidate.context.workspaceId;
  withCandidate.context.candidate = { workspaceId: 'ws-candidate' };
  assert.equal(buildApprovalAdmissionOptions(withCandidate, { workspaceId: 'ws-args' }).workspaceId, 'ws-candidate');
  const bare = { id: 'approval-9', context: {} };
  assert.equal(buildApprovalAdmissionOptions(bare, { workspaceId: 'ws-args' }).workspaceId, 'ws-args');
  assert.equal(buildApprovalAdmissionOptions(bare, {}).workspaceId, 'default');
});

test('provenance defaults are filled in and caller-supplied fields are preserved', () => {
  const approval = baseApproval();
  approval.context.provenance = { provenanceId: 'prov-custom', sourceType: 'github', actor: 'octocat' };
  const options = buildApprovalAdmissionOptions(approval, {});
  assert.equal(options.provenanceId, 'prov-custom');
  assert.equal(options.provenance.sourceType, 'github');
  assert.equal(options.provenance.actor, 'octocat');
  assert.equal(options.provenance.sourceSubType, 'mcp.learn');
  assert.equal(options.provenance.sourceRef, 'key-abc');
  assert.equal(options.provenance.workspaceId, 'ws-primary');
  assert.equal(typeof options.provenance.timestamp, 'string');
  assert.ok(Number.isFinite(Date.parse(options.provenance.timestamp)));
  assert.match(options.provenance.trustPolicyVersion, /contract|mcp-approval|^[0-9]/);
});

test('a malformed approval context fails safe to defaults instead of throwing', () => {
  const options = buildApprovalAdmissionOptions({ id: 'approval-x', context: 'not-an-object' }, {});
  assert.equal(options.workspaceId, 'default');
  assert.deepEqual(options.provenance.sourceType, 'api');
  assert.equal(options.approvalId, 'approval-x');
});
