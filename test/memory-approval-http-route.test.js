'use strict';

/**
 * The HTTP operator approval route.
 *
 * Two claims need the real server process rather than a mounted handler: that
 * the route does not exist without an operator token, and that the shared API
 * key alone cannot decide an approval. Both depend on server.js reading its
 * environment and on lib/http/route-auth-policy.js deciding before any handler
 * runs, so neither is observable from the boundary in isolation.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-memory-approval-'));
const API_KEY = 'test-api-key';
const OPERATOR_TOKEN = 'test-operator-token';

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

function bootAndProbe({ configured }) {
  const caseDir = fs.mkdtempSync(path.join(tempDir, 'case-'));

  const script = `
    const http = require('http');
    const path = require('path');
    const { createMcpOperatorCapability, operatorCapabilityBinding } = require(path.join(${JSON.stringify(repoRoot)}, 'mcpServer'));
    const operatorSecret = ${JSON.stringify(OPERATOR_TOKEN)};
    const caseDir = process.argv[1];
    const configured = process.argv[2] === 'yes';

    Object.assign(process.env, {
      HUQAN_DISABLE_AUTO_LISTEN: '1',
      HUQAN_API_KEY: ${JSON.stringify(API_KEY)},
      HUQAN_MEMORY_PATH: path.join(caseDir, 'memory.json'),
      HUQAN_DB_PATH: path.join(caseDir, 'graph.sqlite'),
    });
    if (configured) process.env.HUQAN_MCP_OPERATOR_TOKEN = ${JSON.stringify(OPERATOR_TOKEN)};

    const server = require(path.join(${JSON.stringify(repoRoot)}, 'server.js'));

    function capability(name, args) {
      return createMcpOperatorCapability({ secret: operatorSecret, ...operatorCapabilityBinding(name, args) });
    }

    function request(method, urlPath, { body, operatorCapability } = {}) {
      return new Promise((resolve, reject) => {
        const raw = body === undefined ? null : JSON.stringify(body);
        const headers = { 'x-api-key': ${JSON.stringify(API_KEY)} };
        if (operatorCapability) headers['x-huqan-operator-capability'] = operatorCapability;
        if (raw !== null) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = Buffer.byteLength(raw);
        }
        const req = http.request({
          hostname: '127.0.0.1', port: server.address().port, path: urlPath, method, headers,
        }, (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: text }));
        });
        req.on('error', reject);
        req.end(raw === null ? undefined : raw);
      });
    }

    (async () => {
      let result;
      try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        const noToken = await request('GET', '/api/v2/memory-approvals');
        const wrongToken = await request('GET', '/api/v2/memory-approvals', { operatorCapability: 'not-a-capability' });
        const listedArgs = { limit: 50, workspaceId: 'default' };
        const listed = await request('GET', '/api/v2/memory-approvals', { operatorCapability: capability('huqan.approvals', listedArgs) });
        const decideNoToken = await request('POST', '/api/v2/memory-approvals/some-id/decision', { body: { decision: 'approved' } });
        const badDecisionArgs = { approvalId: 'some-id', workspaceId: 'default', decision: 'maybe', reason: '' };
        const badDecision = await request('POST', '/api/v2/memory-approvals/some-id/decision', {
          body: { decision: 'maybe' }, operatorCapability: capability('huqan.approve', badDecisionArgs),
        });
        const wrongMethod = await request('POST', '/api/v2/memory-approvals', { body: {} });

        const learn = await request('POST', '/api/v2/workflows/learn', {
          body: { workspaceId: 'default', text: 'http parity sentinel causes durable result' },
        });
        const learnBody = JSON.parse(learn.body);
        const approvalId = learnBody?.data?.approvalId || '';
        const listedAfterArgs = { limit: 50, workspaceId: 'default' };
        const listedAfter = await request('GET', '/api/v2/memory-approvals', {
          operatorCapability: capability('huqan.approvals', listedAfterArgs),
        });
        const approveArgs = { approvalId, workspaceId: 'default', decision: 'approved', reason: 'http parity test' };
        const approved = await request('POST', '/api/v2/memory-approvals/' + encodeURIComponent(approvalId) + '/decision', {
          body: { decision: 'approved', reason: 'http parity test' },
          operatorCapability: capability('huqan.approve', approveArgs),
        });
        const verified = await request('POST', '/api/v2/workflows/verify', {
          body: { workspaceId: 'default', claim: 'http parity sentinel causes durable result' },
        });

        result = { noToken, wrongToken, listed, decideNoToken, badDecision, wrongMethod, learn, listedAfter, approved, verified };
      } finally {
        if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
        try { server.closeHuqan(); } catch (_) {}
      }
      process.stdout.write('APPROVAL_PROBE ' + JSON.stringify(result) + '\\n');
    })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  `;

  const output = execFileSync(process.execPath, ['-e', script, caseDir, configured ? 'yes' : 'no'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const line = output.split('\n').find((l) => l.startsWith('APPROVAL_PROBE '));
  assert.ok(line, `no probe result in output:\n${output}`);
  return JSON.parse(line.slice('APPROVAL_PROBE '.length));
}

test('without an operator token the route does not exist', () => {
  // 404, not 403: an unconfigured deployment must not advertise a surface it
  // would always refuse. Same shape as /api/a2a/exchange and the
  // external-client route.
  const result = bootAndProbe({ configured: false });

  assert.equal(result.noToken.status, 404);
  assert.equal(result.listed.status, 404);
  assert.equal(result.decideNoToken.status, 404);
});

test('the API key alone cannot reach the approval queue', () => {
  // The property this route exists to preserve: whoever may propose a memory
  // write must not be able to approve it. The API key authenticates /upload.
  const result = bootAndProbe({ configured: true });

  assert.equal(result.noToken.status, 403);
  assert.match(result.noToken.body, /OPERATOR_AUTH_REQUIRED/);
  assert.equal(result.decideNoToken.status, 403);
  assert.match(result.decideNoToken.body, /OPERATOR_AUTH_REQUIRED/);
});

test('a wrong operator capability is refused exactly like a missing one', () => {
  const result = bootAndProbe({ configured: true });

  assert.equal(result.wrongToken.status, 403);
  assert.match(result.wrongToken.body, /OPERATOR_AUTH_REQUIRED/);
});

test('the scoped operator capability lists the approval queue', () => {
  const result = bootAndProbe({ configured: true });

  assert.equal(result.listed.status, 200);
  const body = JSON.parse(result.listed.body);
  assert.ok(Array.isArray(body.approvals), 'expected an approvals array');
  assert.equal(typeof body.pendingCount, 'number');
});

test('HTTP learn queues a durable MCP approval that the operator can apply', () => {
  const result = bootAndProbe({ configured: true });
  assert.equal(result.learn.status, 202);
  const learned = JSON.parse(result.learn.body);
  assert.equal(learned.status, 'review_required');
  assert.match(learned.data.approvalId, /^approval-/);
  assert.equal(learned.data.approval.persisted, true);

  assert.equal(result.listedAfter.status, 200);
  const listed = JSON.parse(result.listedAfter.body);
  assert.ok(listed.approvals.some(item => item.id === learned.data.approvalId));

  assert.equal(result.approved.status, 200);
  const approved = JSON.parse(result.approved.body);
  assert.equal(approved.data.executed, true);
  assert.equal(approved.data.approval.id, learned.data.approvalId);

  assert.equal(result.verified.status, 200);
  const verified = JSON.parse(result.verified.body);
  assert.equal(verified.data.status, 'verified');
});

test('an invalid decision is refused after authorization', () => {
  const result = bootAndProbe({ configured: true });

  assert.equal(result.badDecision.status, 400);
  assert.match(result.badDecision.body, /INVALID_APPROVAL_DECISION/);
});

test('the list path refuses a POST', () => {
  const result = bootAndProbe({ configured: true });

  assert.equal(result.wrongMethod.status, 405);
});
