'use strict';

// #4065 PR-1: the HTTP production entry opens and decides native Coder cases.
// Real oversight runtime, real Git repository, real capability check.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const { httpCoderFixture } = require('./helpers/http-coder-fixture');

test('an approved Coder case binds the exact repository and needs a distinct operator', async t => {
  const f = httpCoderFixture(t);
  const opened = await f.open();
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const { caseId } = opened.body.data;
  assert.equal(f.runtime.getReviewCase(caseId).case.status, 'pending');
  const unsigned = await f.call(`/api/v2/agent/coder/cases/${encodeURIComponent(caseId)}/decision`,
    { workspaceId: 'default', decision: 'approved', reason: 'approve exact project' });
  assert.equal(unsigned.status, 403);
  assert.equal(unsigned.body.error.code, 'OPERATOR_AUTH_REQUIRED');
  const approved = await f.decide(caseId);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(f.runtime.getReviewCase(caseId).case.status, 'approved');
});

test('the requester cannot approve its own Coder case', async t => {
  const f = httpCoderFixture(t, { approver: 'agent:coder' });
  const { caseId } = (await f.open()).body.data;
  const refused = await f.decide(caseId);
  assert.equal(refused.status, 409);
  assert.equal(f.runtime.getReviewCase(caseId).case.status, 'pending');
});

test('scope outside the allowlists or task kinds other than initialize_project are refused', async t => {
  const f = httpCoderFixture(t);
  const outsideRoot = await f.open({ root: f.dir });
  assert.equal(outsideRoot.status, 403);
  assert.match(outsideRoot.body.error.message, /HUQAN_CODER_ROOTS/);
  const outsideTarget = await f.open({ task: f.task('escape', { target: path.join(f.dir, 'escape') }) });
  assert.equal(outsideTarget.status, 403);
  assert.match(outsideTarget.body.error.message, /HUQAN_CODER_TARGET_ROOT/);
  const traversal = await f.open({ task: f.task('dots', { target: path.join(f.targets, '..', 'dots') }) });
  assert.equal(traversal.status, 403);
  const edit = await f.open({ task: { id: 'edit', operation: { type: 'replace_text', path: 'seed.txt' } } });
  assert.equal(edit.status, 403);
  assert.match(edit.body.error.message, /initialize_project/);
});

test('missing oversight, an installed authority or an emergency stop fail closed', async t => {
  assert.equal((await httpCoderFixture(t, { unconfigured: true }).open()).body.error.code, 'CODER_OVERSIGHT_UNCONFIGURED');
  assert.equal((await httpCoderFixture(t, { authority: 'service' }).open()).body.error.code, 'AUTHORITY_DECISION_REQUIRED');
  const stopped = httpCoderFixture(t, { emergencyStop: { check: () => ({ stopped: true, scope: 'workspace', reason: 'drill' }) } });
  const refusal = await stopped.open();
  assert.equal(refusal.body.error.code, 'EMERGENCY_STOPPED');
});

test('a dirty repository or a malformed request opens no case', async t => {
  const f = httpCoderFixture(t);
  fs.writeFileSync(path.join(f.source, 'seed.txt'), 'dirty');
  const dirty = await f.open();
  assert.equal(dirty.status, 400);
  assert.equal(dirty.body.error.code, 'CODER_TASK_REFUSED');
  assert.equal((await f.open({ goal: '' })).status, 400);
  const badId = await f.call('/api/v2/agent/coder/cases/%E0%A4%A/decision', { workspaceId: 'default', decision: 'approved' });
  assert.equal(badId.status, 400);
});

test('the central policy declares every Coder path as authenticated', () => {
  for (const route of ['/api/v2/agent/coder/cases', '/api/v2/agent/coder/cases/case-1/decision', '/api/v2/agent/coder/runs']) {
    const policy = resolveRouteAuthPolicy(route, 'POST');
    assert.equal(policy.known, true, route);
    assert.equal(policy.authRequired, true, route);
  }
});

test('the decision route refuses a review case that is not a Coder case', async t => {
  const f = httpCoderFixture(t);
  const other = f.runtime.createReviewCase({ firewallDecision: 'review', requesterContext: { identityRef: 'agent:mailer' },
    action: { workspaceId: 'default', actionFingerprint: 'action:mail:1', connectorRef: 'connector:mcp-mail',
      resourceRef: 'resource:mailbox', policyVersion: 'policy-v1', firewallVersion: 'agent-action-firewall-v1',
      requestedVerdict: 'review', requestedEffect: 'send one email', actionType: 'send_email', toolName: 'mcp.mail.send',
      target: 'mailbox', args: { to: 'a' } } });
  assert.equal(other.ok, true, JSON.stringify(other));
  const refused = await f.decide(other.case.caseId);
  assert.equal(refused.status, 404);
  assert.equal(f.runtime.getReviewCase(other.case.caseId).case.status, 'pending');
});
