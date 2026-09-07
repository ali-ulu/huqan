'use strict';

/**
 * Contract for the inter-agent delegation audit trail (#1891).
 *
 * The gap this closes is asymmetric, and the asymmetry is what the assertions
 * are about. Before this, an *admitted* exchange left a `.completed` task
 * record — an accounting row that names the exchange but not who delegated to
 * whom — and a *refused* exchange left nothing on disk at all. So the load
 * bearing test here is the refusal one: a rejected attempt to delegate
 * authority is the event an auditor most wants and the one that used to
 * evaporate with the HTTP response.
 *
 * The rest pins the properties that make the trail usable as evidence rather
 * than as decoration: it names both parties, a read is bounded, an unparseable
 * row is reported instead of dropped, and recording can never fail an exchange.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildFixture } = require('../scripts/a2a-conformance/run.js');
const { CANONICAL_WORKSPACE, createA2aExchangeBoundary } = require('../lib/a2a/exchange-route');
const {
  DELEGATION_AUDIT_SUFFIX,
  DELEGATION_OUTCOMES,
  createA2aDelegationAuditLog,
} = require('../lib/a2a/delegation-audit-log');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-audit-'));
  const replayDirectory = path.join(root, 'replay');
  fs.mkdirSync(replayDirectory);
  const fixture = buildFixture(CANONICAL_WORKSPACE);
  const authorityFile = path.join(root, 'authority.json');
  fs.writeFileSync(authorityFile, JSON.stringify(fixture.authority), 'utf8');
  return { root, replayDirectory, authorityFile, fixture };
}

async function post(sandbox, body) {
  const boundary = createA2aExchangeBoundary({
    authorityFile: sandbox.authorityFile,
    replayDirectory: sandbox.replayDirectory,
  });
  assert.ok(boundary, 'the exchange boundary must construct for this sandbox');
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    boundary.route(req, res, reqUrl).then((handled) => {
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const payload = JSON.stringify(body);
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/a2a/exchange',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    return { response, audit: boundary.readDelegationAudit() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('delegation audit: an admitted exchange records who delegated to whom', async () => {
  const sandbox = makeSandbox();
  const { response, audit } = await post(sandbox, sandbox.fixture.request);

  assert.equal(response.status, 200);
  assert.equal(response.body.decision, 'allow');

  assert.equal(audit.unreadable, 0);
  assert.equal(audit.entries.length, 1);
  const [entry] = audit.entries;
  assert.equal(entry.outcome, DELEGATION_OUTCOMES.ADMITTED);
  assert.equal(entry.decision, 'allow');
  assert.equal(entry.exchangeId, sandbox.fixture.request.exchangeId);
  // Both parties, which the task record never carried.
  assert.equal(entry.delegatorId, sandbox.fixture.request.source.agentId);
  assert.equal(entry.delegateId, sandbox.fixture.request.target.agentId);
  assert.equal(entry.capability, sandbox.fixture.request.requestedAction.capability);
  // The row points back at the accounting record rather than duplicating it.
  assert.equal(entry.taskId, response.body.effect.taskId);
});

test('delegation audit: a refused exchange is recorded, not discarded', async () => {
  const sandbox = makeSandbox();
  // Tampering after signing: the envelope is well-formed enough to name a
  // delegator and delegate, and its signature no longer covers it.
  const tampered = JSON.parse(JSON.stringify(sandbox.fixture.request));
  tampered.requestedAction.capability = `${tampered.requestedAction.capability}-tampered`;

  const { response, audit } = await post(sandbox, tampered);

  assert.notEqual(response.status, 200);
  assert.notEqual(response.body.decision, 'allow');

  assert.equal(audit.entries.length, 1, 'a refused delegation must leave a durable row');
  const [entry] = audit.entries;
  assert.equal(entry.outcome, DELEGATION_OUTCOMES.REFUSED);
  assert.equal(entry.delegatorId, tampered.source.agentId);
  assert.equal(entry.delegateId, tampered.target.agentId);
  // A refusal has no effect, so it must not claim one.
  assert.equal(entry.taskId, null);
  assert.ok(entry.reason.length > 0, 'a refusal row must say why');
});

test('delegation audit: a body that never named a delegator writes no row', async () => {
  const sandbox = makeSandbox();
  const { response, audit } = await post(sandbox, []);

  assert.equal(response.status, 400);
  // Recording a transport-level refusal would fill the trail with rows whose
  // every identifier is empty, which is noise an auditor has to filter before
  // the trail says anything.
  assert.equal(audit.entries.length, 0);
});

test('delegation audit: reads are bounded and report rows they could not parse', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-audit-read-'));
  const log = createA2aDelegationAuditLog(root);

  for (let index = 0; index < 5; index += 1) {
    const written = log.append({
      request: {
        exchangeId: `exchange-${index}`,
        source: { agentId: `delegator-${index}` },
        target: { agentId: 'delegate' },
        requestedAction: { capability: 'read', riskTier: 'low' },
        delegation: { chain: ['delegator', 'delegate'], hops: [{}] },
      },
      outcome: DELEGATION_OUTCOMES.ADMITTED,
      decision: 'allow',
      reason: 'ok',
      // Distinct enough to assert ordering without depending on clock resolution.
      recordedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
    });
    assert.ok(written, 'append must report what it wrote');
    assert.equal(written.hopCount, 1);
  }

  const all = log.read();
  assert.equal(all.entries.length, 5);
  assert.equal(all.unreadable, 0);

  const bounded = log.read({ limit: 2 });
  assert.equal(bounded.entries.length, 2, 'a read must not grow with the directory');

  fs.writeFileSync(path.join(root, `999999999999999-broken${DELEGATION_AUDIT_SUFFIX}`), 'not json', 'utf8');
  const withBroken = log.read();
  assert.equal(withBroken.unreadable, 1, 'an unparseable row is reported, not silently dropped');
  assert.equal(withBroken.entries.length, 5, 'and it does not remove the readable ones');
});

test('delegation audit: recording never throws, so it cannot fail an exchange', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-audit-fail-'));
  const log = createA2aDelegationAuditLog(root);
  fs.rmSync(root, { recursive: true, force: true });

  // The directory is gone underneath the log. The write cannot succeed, and the
  // caller must still be told nothing worse than "nothing was written".
  assert.equal(log.append({
    request: { exchangeId: 'e', source: { agentId: 'a' }, target: { agentId: 'b' } },
    outcome: DELEGATION_OUTCOMES.REFUSED,
    decision: 'block',
    reason: 'whatever',
  }), null);

  // And a read of a directory that no longer exists is empty, not a throw.
  assert.deepEqual(log.read(), { entries: [], unreadable: 0 });
});
