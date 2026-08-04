'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createExternalClientHttpAdapter } = require('../lib/external-client-http-adapter');
const { buildExternalClientEndpointContract, EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV,
  EXTERNAL_CLIENT_ENDPOINT_PATH } = require('../lib/external-client-endpoint-contract');
const { createRouteFixture } = require('./helpers/external-client-route-fixture');
const { createRouteHarness, probeRealServer } = require('./helpers/external-client-route-harness');
function body(fixture, pkg = fixture.packageValue()) { return JSON.stringify(fixture.envelope(pkg)); }
function exactSuccess(response, replayed) {
  assert.equal(response.statusCode, replayed ? 200 : 201);
  assert.deepEqual(Object.keys(response.body), ['ok','outcome','replayed','operationId','localCandidateId','receiptId']);
  assert.equal(response.body.ok, true); assert.equal(response.body.outcome, 'pending_review');
  assert.equal(response.body.replayed, replayed);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /^application\/json; charset=utf-8$/);
}
function stateCounts(fixture) {
  const state = fixture.state();
  return [state.candidates.length, state.journals.length, state.receipts.length];
}
test('real server remains generic 404 for disabled and requested configuration', async () => {
  for (const [value, expected] of [['false', 'disabled'], ['true', 'requested']]) {
    const contract = buildExternalClientEndpointContract({ [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: value });
    assert.equal(contract.configurationState, expected);
    assert.ok(['routeReachable','identityAuthorityReady','workspaceAuthorityReady','freshnessReady',
      'replayProtectionReady','mutationAllowed','receiptWriterReady'].every((key) => contract[key] === false));
    const response = await probeRealServer(value);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(JSON.parse(response.body), { error: 'Not found' });
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(source.includes(EXTERNAL_CLIENT_ENDPOINT_PATH), false);
  assert.equal(source.includes('external-client-http-adapter'), false);
});

test('rate limit then API key reject before adapter, body, replay or mutation', async (t) => {
  const fixture = createRouteFixture(t);
  const harness = await createRouteHarness({ adapter: fixture.adapter, maxRequests: 2, now: 1000 });
  t.after(() => harness.close());
  assert.equal((await harness.send({ authorized: false, body: body(fixture) })).statusCode, 401);
  assert.equal((await harness.send({ key: 'wrong-key', body: body(fixture) })).statusCode, 401);
  assert.equal((await harness.send({ body: body(fixture) })).statusCode, 429);
  assert.equal(harness.adapterCalls, 0);
  assert.equal(fixture.handlerCalls, 0);
  assert.deepEqual(stateCounts(fixture), [0, 0, 0]);
});

test('valid loopback request returns exact 201 and durable candidate, journal and V2 receipt', async (t) => {
  const fixture = createRouteFixture(t);
  const harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  const response = await harness.send({ headers: { 'content-type': 'application/json' }, body: body(fixture) });
  exactSuccess(response, false);
  const state = fixture.state();
  assert.deepEqual([state.candidates.length, state.journals.length, state.receipts.length], [1, 1, 1]);
  assert.equal(state.candidates[0].candidateId, response.body.localCandidateId);
  assert.equal(state.candidates[0].status, 'pending');
  assert.equal(state.candidates[0].recommendation, 'flag');
  assert.equal(state.journals[0].operation_id, response.body.operationId);
  assert.equal(state.journals[0].status, 'completed');
  const journalResult = JSON.parse(state.journals[0].result);
  assert.equal(journalResult.operationId, response.body.operationId);
  assert.equal(journalResult.localCandidateId, response.body.localCandidateId);
  assert.equal(journalResult.receiptId, response.body.receiptId);
  assert.equal(state.receipts[0].receipt_id, response.body.receiptId);
  assert.equal(state.receipts[0].canonicalPayload.trustRoot, 'external_verified_client');
  assert.equal(state.receipts[0].canonicalPayload.verdict, 'review');
  assert.equal(state.receipts[0].canonicalPayload.decision, 'review');
  assert.equal(state.receipts[0].canonicalPayload.status, 'pending');
});

test('concurrent identical HTTP requests produce one quarantine and one replay rejection', async (t) => {
  const fixture = createRouteFixture(t);
  const harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  const raw = body(fixture);
  const responses = await Promise.all([
    harness.send({ headers: { 'content-type': 'application/json' }, body: raw }),
    harness.send({ headers: { 'content-type': 'application/json' }, body: raw }),
  ]);
  assert.deepEqual(responses.map((item) => item.statusCode).sort(), [201, 409]);
  assert.deepEqual(stateCounts(fixture), [1, 1, 1]);
  assert.equal(fixture.handlerCalls, 1);
});

test('durable Authority replay survives replay-store close and reopen without second mutation', async (t) => {
  const fixture = createRouteFixture(t);
  let harness = await createRouteHarness({ adapter: fixture.adapter });
  const raw = body(fixture);
  exactSuccess(await harness.send({ headers: { 'content-type': 'application/json' }, body: raw }), false);
  await harness.close();
  fixture.restartReplay();
  harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  const replay = await harness.send({ headers: { 'content-type': 'application/json' }, body: raw });
  assert.equal(replay.statusCode, 409);
  assert.deepEqual(replay.body, { ok: false });
  assert.deepEqual(stateCounts(fixture), [1, 1, 1]);
  assert.equal(fixture.handlerCalls, 1);
});

test('mutation-journal replay is distinct and maps to exact 200', async (t) => {
  const fixture = createRouteFixture(t);
  let harness = await createRouteHarness({ adapter: fixture.adapter });
  const raw = body(fixture);
  exactSuccess(await harness.send({ headers: { 'content-type': 'application/json' }, body: raw }), false);
  await harness.close();
  harness = await createRouteHarness({ adapter: fixture.journalReplayAdapter() });
  t.after(() => harness.close());
  exactSuccess(await harness.send({ headers: { 'content-type': 'application/json' }, body: raw }), true);
  assert.deepEqual(stateCounts(fixture), [1, 1, 1]);
});

test('caller authority, malformed transport and package failures create no domain rows', async (t) => {
  const cases = [
    { body: '{"package":{},"signature":{"algorithm":"ed25519","keyId":"x","value":"y"},"identity":"spoof"}' },
    { body: '{' }, { body: '[]' },
    { body: '{"package":{"__proto__":{"polluted":true}},"signature":{"algorithm":"a","keyId":"b","value":"c"}}' },
    { method: 'GET', body: '' }, { headers: {}, body: '{}' },
    { headers: { 'content-type': 'text/plain' }, body: '{}' },
    { headers: { 'content-type': 'application/json; profile=x' }, body: '{}' },
  ];
  for (const item of cases) {
    const fixture = createRouteFixture(t);
    const harness = await createRouteHarness({ adapter: fixture.adapter });
    const response = await harness.send({ headers: item.headers || { 'content-type': 'application/json' },
      method: item.method, body: item.body });
    assert.ok([400, 403, 405, 415, 422].includes(response.statusCode));
    assert.deepEqual(stateCounts(fixture), [0, 0, 0]);
    await harness.close();
  }
});

test('primitive envelopes and every caller authority field fail before delegation', async (t) => {
  const fixture = createRouteFixture(t);
  const harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  for (const raw of ['', 'null', '1', '"text"']) {
    assert.equal((await harness.send({ headers: { 'content-type': 'application/json' }, body: raw })).statusCode, 400);
  }
  for (const key of ['identity','workspaceId','packageId','permissions','trustedKeys','trustRoot','clock','replayStore','handler','retry']) {
    const envelope = fixture.envelope(); envelope[key] = 'caller-controlled';
    assert.equal((await harness.send({ headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope) })).statusCode, 400);
  }
  assert.equal(fixture.handlerCalls, 0);
  assert.deepEqual(stateCounts(fixture), [0, 0, 0]);
});

test('signature, key, freshness, identity and package scope failures are mutation-free', async (t) => {
  const crypto = require('node:crypto');
  const cases = [
    (fixture) => { const pkg = fixture.packageValue(); return { pkg,
      signature: fixture.sign(pkg, crypto.generateKeyPairSync('ed25519').privateKey) }; },
    (fixture) => { const pkg = fixture.packageValue(); return { pkg,
      signature: { ...fixture.sign(pkg, fixture.keys.privateKey), keyId: 'unknown-key' } }; },
    (fixture) => { const pkg = fixture.packageValue(); return { pkg,
      signature: { algorithm: 'rsa', keyId: fixture.IDS.keyId, value: 'malformed' } }; },
    (fixture) => { const pkg = fixture.packageValue({ manifest: { format: 'invalid-format' } });
      return { pkg, signature: fixture.sign(pkg, fixture.keys.privateKey) }; },
    (fixture) => { const pkg = fixture.packageValue({ manifest: { createdAt: '2020-01-01T00:00:00.000Z' } });
      return { pkg, signature: fixture.sign(pkg, fixture.keys.privateKey) }; },
    (fixture) => { const pkg = fixture.packageValue({ manifest: { createdAt: '2030-01-01T00:00:00.000Z' } });
      return { pkg, signature: fixture.sign(pkg, fixture.keys.privateKey) }; },
    (fixture) => { const pkg = fixture.packageValue({ manifest: { workspaceId: 'workspace-other' } });
      return { pkg, signature: fixture.sign(pkg, fixture.keys.privateKey) }; },
    (fixture) => { const pkg = fixture.packageValue({ manifest: { packageId: 'pkg.other' } });
      return { pkg, signature: fixture.sign(pkg, fixture.keys.privateKey) }; },
    (fixture) => { const pkg = fixture.packageValue({ manifest: { createdBy: 'connector:other' } });
      return { pkg, signature: fixture.sign(pkg, fixture.keys.privateKey) }; },
  ];
  for (const makeCase of cases) {
    const fixture = createRouteFixture(t); const { pkg, signature } = makeCase(fixture);
    const harness = await createRouteHarness({ adapter: fixture.adapter });
    const response = await harness.send({ headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: pkg, signature }) });
    assert.ok([403, 422].includes(response.statusCode));
    assert.deepEqual(stateCounts(fixture), [0, 0, 0]);
    assert.equal(JSON.stringify(response).includes(signature.value), false);
    await harness.close();
  }
  const fixture = createRouteFixture(t);
  assert.throws(() => fixture.materializeProfile({ revoked: true }),
    (error) => error?.code === 'EXTERNAL_CLIENT_AUTHORITY_KEY_REVOKED');
  assert.deepEqual(stateCounts(fixture), [0, 0, 0]);
});

test('transport headers, observed bytes, depth and value bounds fail before mutation', async (t) => {
  const fixture = createRouteFixture(t);
  const harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  const nested = {}; let current = nested;
  for (let index = 0; index < 32; index += 1) { current.next = {}; current = current.next; }
  const raws = [Buffer.from([0xc3, 0x28]),
    JSON.stringify({ package: nested, signature: { algorithm: 'a', keyId: 'b', value: 'c' } }),
    JSON.stringify({ package: { values: Array(9994).fill(0) }, signature: { algorithm: 'a', keyId: 'b', value: 'c' } })];
  for (const raw of raws) {
    assert.equal((await harness.send({ headers: { 'content-type': 'application/json' }, body: raw })).statusCode, 400);
  }
  assert.equal((await harness.send({ headers: { 'content-type': 'application/json', 'content-length': '1048577' },
    contentLength: false, body: '' })).statusCode, 413);
  assert.equal((await harness.send({ headers: { 'content-type': 'application/json' }, contentLength: false,
    chunks: [Buffer.alloc(600000), Buffer.alloc(600000)] })).statusCode, 413);
  assert.equal((await harness.raw(['Content-Type: application/json', 'Content-Type: text/plain',
    'Content-Length: 2'], '{}')).statusCode, 415);
  assert.equal((await harness.raw(['Content-Type: application/json', 'Content-Length: 2',
    'Content-Length: 3'], '{}')).statusCode, 400);
  assert.deepEqual(stateCounts(fixture), [0, 0, 0]);
  assert.equal(fixture.handlerCalls, 0);
});

test('client abort settles before delegation and leaves no durable evidence', async (t) => {
  const fixture = createRouteFixture(t);
  const harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  await harness.abort('{"package":');
  assert.equal(fixture.handlerCalls, 0);
  assert.deepEqual(stateCounts(fixture), [0, 0, 0]);
});

test('replay reservation failure and hostile result fail once before handler', async (t) => {
  for (const replayReserve of [
    () => { throw new Error('private replay failure'); },
    () => ({ reserved: 'yes' }),
  ]) {
    const fixture = createRouteFixture(t, { replayReserve });
    const harness = await createRouteHarness({ adapter: fixture.adapter });
    const response = await harness.send({ headers: { 'content-type': 'application/json' }, body: body(fixture) });
    assert.equal(response.statusCode, 503);
    assert.equal(fixture.replayCalls, 1); assert.equal(fixture.handlerCalls, 0);
    assert.deepEqual(stateCounts(fixture), [0, 0, 0]);
    await harness.close();
  }
});

test('real handler failure and mutation uncertainty do not retry', async (t) => {
  const handlerError = new Error('private handler failure'); handlerError.code = 'PRIVATE_HANDLER_FAILURE';
  const rejected = createRouteFixture(t, { handlerError });
  let harness = await createRouteHarness({ adapter: rejected.adapter });
  const raw = body(rejected);
  const first = await harness.send({ headers: { 'content-type': 'application/json' }, body: raw });
  assert.equal(first.statusCode, 503); assert.equal(rejected.handlerCalls, 1);
  const second = await harness.send({ headers: { 'content-type': 'application/json' }, body: raw });
  assert.equal(second.statusCode, 409); assert.equal(rejected.handlerCalls, 1);
  assert.deepEqual(stateCounts(rejected), [0, 0, 0]);
  await harness.close();

  const uncertain = createRouteFixture(t);
  const original = uncertain.graph.addCandidateClaim.bind(uncertain.graph);
  uncertain.graph.addCandidateClaim = (...args) => { original(...args); throw new Error('forced uncertainty'); };
  harness = await createRouteHarness({ adapter: uncertain.adapter });
  const response = await harness.send({ headers: { 'content-type': 'application/json' }, body: body(uncertain) });
  assert.equal(response.statusCode, 503); assert.deepEqual(response.body, { ok: false });
  assert.equal(uncertain.handlerCalls, 1); assert.deepEqual(stateCounts(uncertain), [0, 0, 0]);
  await harness.close();
});

test('dependency errors and malformed success settle once without secret leakage', async () => {
  const failures = [
    async () => { const error = new Error('secret-message'); error.code = 'EXTERNAL_CLIENT_MUTATION_OUTCOME_UNKNOWN'; throw error; },
    async () => { const error = new Error('secret-message'); error.code = 'PRIVATE_UNKNOWN'; throw error; },
    async () => ({ ok: true, gate: Object.freeze({}), authority: Object.freeze({}), admission: Object.freeze({}) }),
    async () => Object.freeze({ ok: true }),
    async () => Object.freeze({ ok: true, gate: Object.freeze({}), authority: Object.freeze({}),
      admission: Object.freeze({ ok: true, outcome: 'pending_review', replayed: 'yes',
        operationId: 'op', localCandidateId: 'candidate', receiptId: 'receipt' }) }),
  ];
  for (const failure of failures) {
    let calls = 0;
    const adapter = createExternalClientHttpAdapter({ admitPackage: async () => { calls += 1; return failure(); } });
    const harness = await createRouteHarness({ adapter });
    const response = await harness.send({ headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: {}, signature: { algorithm: 'ed25519', keyId: 'x', value: 'secret-signature' } }) });
    assert.equal(response.statusCode, 503); assert.deepEqual(response.body, { ok: false });
    assert.equal(calls, 1); assert.equal(JSON.stringify(response).includes('secret'), false);
    await harness.close();
  }
});

test('static scope, line budgets and npm dry-run preserve package boundaries', () => {
  const root = path.join(__dirname, '..');
  const files = ['test/external-client-route-adversarial.test.js',
    'test/helpers/external-client-route-harness.js', 'test/helpers/external-client-route-fixture.js'];
  for (const file of files) assert.ok(fs.readFileSync(path.join(root, file), 'utf8').trimEnd().split(/\r?\n/).length <= 300);
  const packed = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
  const names = new Set(packed[0].files.map((entry) => entry.path));
  for (const file of files.concat(['lib/external-client-endpoint-contract.js','lib/external-client-trust-config.js',
    'lib/external-client-replay-store.js','lib/external-client-mutation-receipt-owner.js','lib/external-client-http-adapter.js'])) {
    assert.equal(names.has(file), false, file);
  }
  assert.equal(names.has('lib/external-client-authority.js'), true);
  assert.equal(names.has('lib/external-client-package-gate.js'), true);
});