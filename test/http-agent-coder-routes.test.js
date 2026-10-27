'use strict';

// #4065 PR-1: the HTTP production entry opens and decides native Coder cases.
// Real oversight runtime, real Git repository, real capability check.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const { execFileSync } = require('node:child_process');
const Graph = require('../graph');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { createMcpOperatorCapability } = require('../lib/mcp-operator-capability');
const { operatorCapabilityBinding } = require('../lib/mcp/operator-authorization');
const { createAgentCoderRoutes } = require('../lib/http/agent-coder-routes');

const SECRET = 'coder-operator-secret';
const HEADER = 'x-huqan-operator-capability';
const spec = { kind: 'project_spec', name: 'double-api', archetype: 'node_computed_json_api',
  routes: [{ path: '/double', compute: { family: 'array-map', examples: [
    { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [3, 4], expected: [6, 8] },
  ], acceptanceExamples: [{ input: [-3, 8], expected: [-6, 16] }, { input: [7], expected: [14] },
    { input: [-2, 0, 5], expected: [-4, 0, 10] }] } }] };

function fixture(t, options = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'http-coder-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'); fs.mkdirSync(source);
  const targets = path.join(dir, 'targets'); fs.mkdirSync(targets);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'feature/coder'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(source, 'seed.txt'), 'source'); git('add', 'seed.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const runtime = createHumanOversightApprovalRuntime({ graph, ledger: createTrustEvidenceLedger({ graph }),
    resolveIdentity: ({ context, action }) => ({ decision: 'allow', identity: {
      identityRef: context.identityRef, identityHash: `${context.identityRef}-hash`, workspaceId: action.workspaceId,
      agentId: '', ownerActorId: context.identityRef, authorityRef: 'fixture-owner' } }) });
  const approver = options.approver || 'human:operator';
  const environment = { HUQAN_CODER_ROOTS: source, HUQAN_CODER_TARGET_ROOT: targets, ...options.environment };
  const responses = [];
  const handle = createAgentCoderRoutes({
    parseJsonRequest: async req => req.body,
    writeJson: (req, res, status, body) => responses.push({ status, body }),
    getOversightConfig: () => (options.unconfigured ? null : { runtime,
      humanOversightRequesterContext: { identityRef: 'agent:coder' },
      humanOversightApproverContext: { identityRef: approver } }),
    resolveAuthorityMode: () => ({ mode: options.authority || 'legacy' }),
    emergencyStop: options.emergencyStop,
    operatorToken: SECRET,
    operatorCapabilityNonces: new Set(),
    readEnvironment: name => environment[name],
  });
  async function call(pathname, body, capability) {
    const req = { method: 'POST', headers: capability ? { [HEADER]: capability } : {}, body };
    const handled = await handle(req, {}, { pathname });
    assert.equal(handled, true);
    return responses.at(-1);
  }
  const task = (name = 'project', target = path.join(targets, name)) => {
    fs.mkdirSync(target, { recursive: true });
    return { id: name, operation: { type: 'initialize_project', targetRoot: target, spec } };
  };
  const open = (overrides = {}) => call('/api/v2/agent/coder/cases',
    { workspaceId: 'default', root: source, goal: 'create the approved double API', task: task(), ...overrides });
  const decide = (caseId, decision = 'approved', reason = 'approve exact project') => call(
    `/api/v2/agent/coder/cases/${encodeURIComponent(caseId)}/decision`, { workspaceId: 'default', decision, reason },
    createMcpOperatorCapability({ secret: SECRET, ...operatorCapabilityBinding('huqan.approve',
      { approvalId: caseId, workspaceId: 'default', decision, reason }) }));
  return { dir, source, targets, runtime, open, decide, call, task };
}

test('an approved Coder case binds the exact repository and needs a distinct operator', async t => {
  const f = fixture(t);
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
  const f = fixture(t, { approver: 'agent:coder' });
  const { caseId } = (await f.open()).body.data;
  const refused = await f.decide(caseId);
  assert.equal(refused.status, 409);
  assert.equal(f.runtime.getReviewCase(caseId).case.status, 'pending');
});

test('scope outside the allowlists or task kinds other than initialize_project are refused', async t => {
  const f = fixture(t);
  const outsideRoot = await f.open({ root: f.dir });
  assert.equal(outsideRoot.status, 403);
  assert.match(outsideRoot.body.error.message, /HUQAN_CODER_ROOTS/);
  const outsideTarget = await f.open({ task: f.task('escape', path.join(f.dir, 'escape')) });
  assert.equal(outsideTarget.status, 403);
  assert.match(outsideTarget.body.error.message, /HUQAN_CODER_TARGET_ROOT/);
  const traversal = await f.open({ task: f.task('dots', path.join(f.targets, '..', 'dots')) });
  assert.equal(traversal.status, 403);
  const edit = await f.open({ task: { id: 'edit', operation: { type: 'replace_text', path: 'seed.txt' } } });
  assert.equal(edit.status, 403);
  assert.match(edit.body.error.message, /initialize_project/);
});

test('missing oversight, an installed authority or an emergency stop fail closed', async t => {
  assert.equal((await fixture(t, { unconfigured: true }).open()).body.error.code, 'CODER_OVERSIGHT_UNCONFIGURED');
  assert.equal((await fixture(t, { authority: 'service' }).open()).body.error.code, 'AUTHORITY_DECISION_REQUIRED');
  const stopped = fixture(t, { emergencyStop: { check: () => ({ stopped: true, scope: 'workspace', reason: 'drill' }) } });
  const refusal = await stopped.open();
  assert.equal(refusal.body.error.code, 'EMERGENCY_STOPPED');
});

test('a dirty repository or a malformed request opens no case', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'seed.txt'), 'dirty');
  const dirty = await f.open();
  assert.equal(dirty.status, 400);
  assert.equal(dirty.body.error.code, 'CODER_TASK_REFUSED');
  assert.equal((await f.open({ goal: '' })).status, 400);
  const badId = await f.call('/api/v2/agent/coder/cases/%E0%A4%A/decision', { workspaceId: 'default', decision: 'approved' });
  assert.equal(badId.status, 400);
});

test('the central policy declares both Coder paths as authenticated', () => {
  for (const route of ['/api/v2/agent/coder/cases', '/api/v2/agent/coder/cases/case-1/decision']) {
    const policy = resolveRouteAuthPolicy(route, 'POST');
    assert.equal(policy.known, true, route);
    assert.equal(policy.authRequired, true, route);
  }
});

test('the decision route refuses a review case that is not a Coder case', async t => {
  const f = fixture(t);
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
