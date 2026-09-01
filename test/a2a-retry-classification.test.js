'use strict';

/**
 * Contract for retry classification, timeouts, and the deliberate absence of
 * cancellation (P0-F).
 *
 * The flag under test answers "can resending this cause a second effect", not
 * "might resending work". Those are different questions and only one of them
 * has a correctness consequence: a caller that treats an unsafe refusal as
 * retryable causes duplicates, while a caller that treats a safe one as
 * unretryable merely gives up early.
 *
 * So the assertions here are asymmetric on purpose. The safe direction is
 * spot-checked; the unsafe direction is pinned exhaustively, including for
 * reason codes that do not exist yet.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildFixture } = require('../scripts/a2a-conformance/run.js');
const { readJsonBody } = require('../requestGuards');
const {
  A2A_ROUTE_ERRORS,
  CANONICAL_WORKSPACE,
  REQUEST_TIMEOUT_MS,
  createA2aExchangeBoundary,
} = require('../lib/a2a/exchange-route');
const { TIMEOUTS, RETRY, UNSUPPORTED_SURFACES } = require('../lib/a2a/agent-card');
const {
  RETRYABLE_EVALUATOR_REASONS,
  classifyEvaluatorReason,
  classifyTransportRefusal,
} = require('../lib/a2a/retry-classification');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-retry-'));
  const replayDirectory = path.join(root, 'replay');
  fs.mkdirSync(replayDirectory);
  const fixture = buildFixture(CANONICAL_WORKSPACE);
  const authorityFile = path.join(root, 'authority.json');
  fs.writeFileSync(authorityFile, JSON.stringify(fixture.authority), 'utf8');
  return { root, replayDirectory, authorityFile, fixture };
}

function freshBoundary() {
  const sandbox = makeSandbox();
  return {
    boundary: createA2aExchangeBoundary({
      authorityFile: sandbox.authorityFile,
      replayDirectory: sandbox.replayDirectory,
    }),
    fixture: sandbox.fixture,
  };
}

async function withServer(boundary, run) {
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    boundary.route(req, res, reqUrl).then((handled) => {
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, { method = 'POST', body, rawBody, contentType = 'application/json' } = {}) {
  const payload = rawBody !== undefined ? rawBody : (body === undefined ? '' : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers = {};
    if (contentType) headers['Content-Type'] = contentType;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/a2a/exchange', method, headers,
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
    if (payload) req.write(payload);
    req.end();
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('retry: a replay is unsafe to retry and points at the task instead', async () => {
  const { boundary, fixture } = freshBoundary();

  const [first, second] = await withServer(boundary, async (port) => [
    await request(port, { body: fixture.request }),
    await request(port, { body: fixture.request }),
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.body.reason, 'replay_detected');
  assert.equal(second.body.safeToRetry, false);
  // A caller told not to retry needs somewhere to look. Withholding the pointer
  // would leave it correctly refused and with nothing to do about it.
  assert.equal(second.body.taskId, first.body.effect.taskId);
});

test('retry: a verification refusal is safe to retry and carries no task pointer', async () => {
  const { boundary, fixture } = freshBoundary();
  const tampered = clone(fixture.request);
  tampered.signature.value = `${'a'.repeat(8)}${String(tampered.signature.value).slice(8)}`;

  const response = await withServer(boundary, (port) => request(port, { body: tampered }));

  assert.equal(response.body.reason, 'exchange_signature_invalid');
  // Refused before the reserve call, so resending cannot double an effect --
  // even though it will fail identically forever.
  assert.equal(response.body.safeToRetry, true);
  assert.equal(response.body.taskId, undefined, 'no reservation means no task to point at');
});

test('retry: transport refusals are safe to retry', async () => {
  const { boundary } = freshBoundary();

  const [wrongMethod, badBody, wrongWorkspace] = await withServer(boundary, async (port) => [
    await request(port, { method: 'GET' }),
    await request(port, { rawBody: '{ not json' }),
    await request(port, { body: { workspaceId: 'other' } }),
  ]);

  for (const [name, response, reason] of [
    ['method', wrongMethod, A2A_ROUTE_ERRORS.METHOD],
    ['body', badBody, A2A_ROUTE_ERRORS.BODY],
    ['workspace', wrongWorkspace, A2A_ROUTE_ERRORS.WORKSPACE],
  ]) {
    assert.equal(response.body.reason, reason, `${name} reason`);
    // Decided before the evaluator is called at all: a reservation cannot exist.
    assert.equal(response.body.safeToRetry, true, `${name} must be safe to retry`);
    assert.equal(response.body.taskId, undefined, `${name} must carry no task pointer`);
  }
});

test('retry: every response carries the flag, so a consumer never has to infer it', async () => {
  const { boundary, fixture } = freshBoundary();

  const responses = await withServer(boundary, async (port) => [
    await request(port, { method: 'GET' }),
    await request(port, { body: { workspaceId: 'other' } }),
    await request(port, { body: fixture.request }),
    await request(port, { body: fixture.request }),
  ]);

  // The admitted one is a success and needs no flag; every refusal has one.
  for (const response of responses) {
    if (response.body.decision === 'allow') continue;
    assert.equal(typeof response.body.safeToRetry, 'boolean');
  }
});

test('retry: the safe set is exactly the pre-reservation evaluator reasons', () => {
  assert.deepEqual([...RETRYABLE_EVALUATOR_REASONS], [
    'consumer_invalid',
    'exchange_shape_invalid',
    'authority_invalid',
    'exchange_expired',
    'identity_invalid',
    'identity_binding_invalid',
    'delegation_chain_invalid',
    'delegation_invalid',
    'delegation_signature_invalid',
    'delegation_scope_escalation',
    'delegation_expired',
    'constraints_exceeded',
    'evidence_action_invalid',
    'evidence_receipt_invalid',
    'evidence_package_invalid',
    'evidence_package_authority_invalid',
    'evidence_refs_invalid',
    'evidence_package_binding_invalid',
    'evidence_receipt_authority_invalid',
    'route_receipt_invalid',
    'exchange_signature_invalid',
  ]);

  for (const reason of RETRYABLE_EVALUATOR_REASONS) {
    assert.equal(classifyEvaluatorReason(reason), true, `${reason} must be safe`);
  }
  for (const reason of ['replay_detected', 'verification_failed']) {
    assert.equal(classifyEvaluatorReason(reason), false, `${reason} must be unsafe`);
  }
});

test('retry: an unrecognised reason shape defaults to unsafe', () => {
  // Fail-closed. A reason this module cannot read must not become a licence to
  // resend, and a future code added without thought must not default to safe by
  // being absent from a list.
  for (const reason of [undefined, null, '', 0, {}, [], true]) {
    assert.equal(classifyEvaluatorReason(reason), false, `${JSON.stringify(reason)} must be unsafe`);
  }

  // A new string reason is unsafe until it is proven to occur before reservation.
  assert.equal(classifyEvaluatorReason('delegation_expired'), true);
  assert.equal(classifyEvaluatorReason('some_future_verification_reason'), false);
});

test('retry: transport classification is structural, not reason-derived', () => {
  // It takes no argument on purpose: the fact that makes it safe is *where the
  // route returned*, not what it said.
  assert.equal(classifyTransportRefusal(), true);
  assert.equal(classifyTransportRefusal.length, 0);
});

test('timeouts: the advertised deadline is the enforced one', () => {
  // One value, not two. A card advertising 30s while the route enforced 10s
  // would be worse than a card that advertised nothing.
  assert.equal(REQUEST_TIMEOUT_MS, TIMEOUTS.requestTimeoutMs);
  assert.equal(typeof REQUEST_TIMEOUT_MS, 'number');
  assert.ok(REQUEST_TIMEOUT_MS > 0);
});

test('timeouts: the socket deadline is applied before the body is read', async () => {
  const { boundary } = freshBoundary();
  const applied = [];
  const req = {
    method: 'POST',
    setTimeout(ms) { applied.push(ms); },
  };

  // The read is stubbed so the assertion is about ordering, not about waiting
  // 30 seconds: the deadline must already be set by the time reading starts.
  await boundary.handle(req, async () => {
    assert.deepEqual(applied, [REQUEST_TIMEOUT_MS], 'deadline must be set before the read begins');
    return { ok: false, status: 400 };
  });

  assert.deepEqual(applied, [REQUEST_TIMEOUT_MS]);
});

test('card: the retry contract is advertised rather than left to be discovered', () => {
  assert.equal(RETRY.responseField, 'safeToRetry');
  assert.equal(RETRY.taskPointerOnUnsafe, true);
  // A consumer that does not know the flag exists invents a retry policy, and
  // the natural invention -- retry on any failure -- is the one this receiver
  // cannot absorb.
  assert.equal(RETRY.semantics, 'safe-to-retry-means-no-effect-possible');
});

test('card: cancellation stays unsupported, and that is a decision not an omission', () => {
  // P0-F shipped timeout and retry. Cancellation has no referent here: the
  // exchange is synchronous, and a reserved exchange is accounted for and
  // cannot be withdrawn. An endpoint whose only answer is "too late" would be
  // theatre. It acquires meaning with an async surface, which is P0-G.
  assert.ok(UNSUPPORTED_SURFACES.includes('cancellation'));
  assert.ok(UNSUPPORTED_SURFACES.includes('idempotency-keys'));
});

test('retry: an admitted exchange is not marked retryable at all', async () => {
  const { boundary, fixture } = freshBoundary();
  const response = await withServer(boundary, (port) => request(port, { body: fixture.request }));

  assert.equal(response.body.decision, 'allow');
  // Success is not a retry question. Emitting the flag here would invite a
  // caller to resend something that already succeeded.
  assert.equal(response.body.safeToRetry, undefined);
});
