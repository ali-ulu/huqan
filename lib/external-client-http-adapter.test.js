'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  EXTERNAL_CLIENT_HTTP_ADAPTER_VERSION,
  EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES,
  EXTERNAL_CLIENT_HTTP_READ_TIMEOUT_MS,
  createExternalClientHttpAdapter,
} = require('./external-client-http-adapter');
const SIGNATURE = Object.freeze({ algorithm: 'ed25519', keyId: 'key-1', value: 'signature' });
class Request extends EventEmitter {
  constructor({ method = 'POST', headers = {}, rawHeaders, chunks = [] } = {}) {
    super();
    this.method = method;
    this.headers = headers;
    if (rawHeaders !== undefined) this.rawHeaders = rawHeaders;
    this.chunks = chunks; this.stoppedByAdapter = null;
  }
  resume() { this.stoppedByAdapter = 'resume'; } destroy() { this.stoppedByAdapter = 'destroy'; }
  start(afterData) {
    queueMicrotask(() => {
      for (const chunk of this.chunks) {
        this.emit('data', chunk);
        if (afterData) afterData(chunk);
      }
      this.emit('end');
    });
    return this;
  }
}
function success(replayed = false, overrides = {}) {
  const admission = Object.freeze({
    ok: true,
    outcome: 'pending_review',
    replayed,
    operationId: 'operation-1',
    localCandidateId: 'candidate-1',
    receiptId: 'receipt-1',
    ...overrides,
  });
  return Object.freeze({
    ok: true,
    gate: Object.freeze({ decision: 'allow' }),
    authority: Object.freeze({ decision: 'allow' }),
    admission,
  });
}
function jsonEnvelope(pkg = {}) {
  return JSON.stringify({ package: pkg, signature: SIGNATURE });
}
function requestFor(raw, options = {}) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const headers = options.headers || { 'content-type': 'application/json' };
  if (options.contentLength) headers['content-length'] = String(body.length);
  return new Request({
    method: options.method,
    headers,
    rawHeaders: options.rawHeaders,
    chunks: options.chunks || [body],
  }).start(options.afterData);
}
function adapterWith(handler = async () => success()) {
  return createExternalClientHttpAdapter({ admitPackage: handler });
}
function assertFailure(result, statusCode) {
  assert.equal(result.statusCode, statusCode);
  assert.deepEqual(result.body, { ok: false });
  assert.deepEqual(Object.keys(result.body), ['ok']);
  assert.deepEqual(Object.keys(result), ['statusCode', 'headers', 'body']);
  const expectedHeaders = statusCode === 405 ? ['Content-Type', 'Cache-Control', 'Allow'] : statusCode === 408 ? ['Content-Type', 'Cache-Control', 'Connection'] : ['Content-Type', 'Cache-Control'];
  assert.deepEqual(Object.keys(result.headers), expectedHeaders);
  assert.ok([result, result.headers, result.body].every(Object.isFrozen));
  assert.deepEqual([result.headers['Content-Type'], result.headers['Cache-Control']], ['application/json; charset=utf-8', 'no-store']);
}
test('exports and factory are exact, immutable and reject hostile dependency shapes', () => {
  assert.equal(EXTERNAL_CLIENT_HTTP_ADAPTER_VERSION, 'external-client-http-adapter-0-v1');
  assert.equal(EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES, 1_048_576);
  assert.equal(EXTERNAL_CLIENT_HTTP_READ_TIMEOUT_MS, 5000);
  const admitPackage = async () => success();
  const adapter = createExternalClientHttpAdapter({ admitPackage });
  assert.deepEqual(Object.keys(adapter), ['handle']);
  assert.equal(Object.isFrozen(adapter), true);
  const inherited = Object.create({ admitPackage });
  const accessor = {};
  let getterCalls = 0;
  Object.defineProperty(accessor, 'admitPackage', { enumerable: true, get() { getterCalls += 1; return admitPackage; } });
  const hidden = {};
  Object.defineProperty(hidden, 'admitPackage', { value: admitPackage, enumerable: false });
  for (const value of [undefined, null, {}, { admitPackage: true }, { admitPackage, extra: true }, inherited, accessor, hidden, { admitPackage, [Symbol('x')]: true }]) {
    assert.throws(() => createExternalClientHttpAdapter(value), TypeError);
  }
  assert.equal(getterCalls, 0);
  const nullPrototype = Object.create(null);
  nullPrototype.admitPackage = admitPackage;
  assert.equal(Object.isFrozen(createExternalClientHttpAdapter(nullPrototype)), true);
});
test('wrong method returns immutable 405 before body consumption or delegation', async () => {
  let calls = 0;
  for (const method of ['GET', 'post', '', null]) {
    const request = new Request({ method, headers: {} });
    const result = await adapterWith(async () => { calls += 1; return success(); }).handle(request);
    assertFailure(result, 405);
    assert.equal(result.headers.Allow, 'POST');
    assert.equal(request.listenerCount('data'), 0);
  }
  assert.equal(calls, 0);
});
test('content type accepts only exact JSON forms and rejects duplicates before delegation', async () => {
  for (const value of ['application/json', ' APPLICATION/JSON ', 'application/json;charset=utf-8', 'application/json; charset = UTF-8 ']) {
    assert.equal((await adapterWith().handle(requestFor(jsonEnvelope(), { headers: { 'content-type': value } }))).statusCode, 201);
  }
  for (const value of [undefined, '', 'text/json', 'application/*', 'application/ld+json', 'application/json; charset=latin1', 'application/json; profile=x', ['application/json']]) {
    const headers = value === undefined ? {} : { 'content-type': value };
    assertFailure(await adapterWith().handle(requestFor(jsonEnvelope(), { headers })), 415);
  }
  const duplicate = requestFor(jsonEnvelope(), { headers: { 'content-type': 'application/json' },
    rawHeaders: ['Content-Type', 'application/json', 'content-type', 'application/json'] });
  assertFailure(await adapterWith().handle(duplicate), 415);
  assertFailure(await adapterWith().handle(requestFor(jsonEnvelope(), { headers: { 'content-type': 'application/json' }, rawHeaders: ['Content-Type', 'text/plain'] })), 415);
  assertFailure(await adapterWith().handle(requestFor(jsonEnvelope(), { headers: { 'content-type': 'application/json', 'content-length': '1' }, rawHeaders: ['Content-Type', 'application/json', 'Content-Length', '2'] })), 400);
});
test('declared and observed byte bounds are exact and malformed lengths fail before reading', async () => {
  for (const value of ['-1', '1.5', '01', 'NaN', [], Number.MAX_SAFE_INTEGER + 1]) {
    const request = new Request({ headers: { 'content-type': 'application/json', 'content-length': value } });
    assertFailure(await adapterWith().handle(request), 400); assert.equal(request.listenerCount('data'), 0);
  }
  const oversized = new Request({ headers: {
    'content-type': 'application/json',
    'content-length': String(EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES + 1),
  } });
  assertFailure(await adapterWith().handle(oversized), 413); assert.equal(oversized.listenerCount('data'), 0);
  const empty = jsonEnvelope({ padding: '' }); const exact = jsonEnvelope({ padding: 'a'.repeat(EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES - Buffer.byteLength(empty)) });
  assert.equal(Buffer.byteLength(exact), EXTERNAL_CLIENT_HTTP_MAX_BODY_BYTES); assert.equal((await adapterWith().handle(requestFor(exact, { contentLength: true }))).statusCode, 201);
  let calls = 0; const observed = requestFor(Buffer.concat([Buffer.from(exact), Buffer.from(' ')]));
  assertFailure(await adapterWith(async () => { calls += 1; return success(); }).handle(observed), 413);
  assert.deepEqual([observed.stoppedByAdapter, observed.listenerCount('data'), calls], ['resume', 0, 0]);
  const fallback = requestFor(Buffer.concat([Buffer.from(exact), Buffer.from(' ')])); fallback.resume = undefined;
  assertFailure(await adapterWith(async () => { calls += 1; return success(); }).handle(fallback), 413); assert.deepEqual([fallback.stoppedByAdapter, calls], ['destroy', 0]);
});
test('raw parsing rejects empty, invalid UTF-8, malformed JSON and invalid exact envelopes', async () => {
  const invalid = [
    '', Buffer.from([0xc3, 0x28]), '{', 'null', '[]', '{"package":{},"signature":{},"extra":true}',
    '{"package":{},"signature":{"algorithm":"a","keyId":"b"}}',
    '{"package":{},"signature":{"algorithm":"a","keyId":"b","value":"c"},"identity":"caller"}',
    '{"package":{"__proto__":{"polluted":true}},"signature":{"algorithm":"a","keyId":"b","value":"c"}}',
    '{"package":{"number":1e400},"signature":{"algorithm":"a","keyId":"b","value":"c"}}',
  ];
  let calls = 0;
  for (const raw of invalid) {
    assertFailure(await adapterWith(async () => { calls += 1; return success(); }).handle(requestFor(raw)), 400);
  }
  assert.equal(calls, 0);
});
test('depth 32 and 10,000 aggregate values pass while the next value fails', async () => {
  const nested = (count) => {
    const root = {};
    let current = root;
    for (let index = 0; index < count; index += 1) {
      current.next = {};
      current = current.next;
    }
    return root;
  };
  assert.equal((await adapterWith().handle(requestFor(jsonEnvelope(nested(31))))).statusCode, 201);
  assertFailure(await adapterWith().handle(requestFor(jsonEnvelope(nested(32)))), 400);
  assert.equal((await adapterWith().handle(requestFor(jsonEnvelope({ values: Array(9993).fill(0) })))).statusCode, 201);
  assertFailure(await adapterWith().handle(requestFor(jsonEnvelope({ values: Array(9994).fill(0) }))), 400);
});
test('delegated input is exact, detached and deeply frozen and delegation happens once', async () => {
  const raw = Buffer.from(jsonEnvelope({ nested: { list: [1, 2, 3] } }));
  let calls = 0;
  const result = await adapterWith(async (input) => {
    calls += 1;
    assert.deepEqual(Object.keys(input), ['package', 'signature']);
    assert.equal(Object.isFrozen(input), true);
    assert.equal(Object.isFrozen(input.package), true);
    assert.equal(Object.isFrozen(input.package.nested), true);
    assert.equal(Object.isFrozen(input.package.nested.list), true);
    assert.equal(Object.isFrozen(input.signature), true);
    assert.throws(() => { input.package.nested.list[0] = 9; }, TypeError);
    assert.equal(input.package.nested.list[0], 1);
    return success();
  }).handle(requestFor(raw, { afterData: (chunk) => chunk.fill(0) }));
  assert.equal(result.statusCode, 201);
  assert.equal(calls, 1);
});
test('stream error, abort and premature close settle once, detach listeners and never delegate', async () => {
  for (const event of ['error', 'aborted', 'close']) {
    const request = new Request({ headers: { 'content-type': 'application/json' } });
    let calls = 0;
    const pending = adapterWith(async () => { calls += 1; return success(); }).handle(request);
    queueMicrotask(() => {
      request.emit(event, event === 'error' ? new Error('secret') : undefined);
      request.emit('data', Buffer.from(jsonEnvelope()));
      request.emit('end');
    });
    assertFailure(await pending, 400);
    assert.equal(calls, 0);
    assert.equal(request.stoppedByAdapter, 'destroy');
    for (const name of ['data', 'end', 'error', 'aborted', 'close']) assert.equal(request.listenerCount(name), 0);
  }
});
test('read timeout returns 408, drains the stream, detaches listeners and does not retry', async () => {
  const request = new Request({ headers: { 'content-type': 'application/json' } });
  let calls = 0;
  const started = Date.now();
  const result = await adapterWith(async () => { calls += 1; return success(); }).handle(request);
  assertFailure(result, 408);
  assert.ok(Date.now() - started >= EXTERNAL_CLIENT_HTTP_READ_TIMEOUT_MS - 25);
  assert.equal(calls, 0);
  assert.equal(request.stoppedByAdapter, 'resume');
  for (const name of ['data', 'end', 'error', 'aborted', 'close']) assert.equal(request.listenerCount(name), 0);
});
test('dependency errors map to bounded statuses without invoking hostile accessors or leaking evidence', async () => {
  const cases = [
    ['EXTERNAL_CLIENT_SIGNATURE_INVALID', 403],
    ['EXTERNAL_CLIENT_WORKSPACE_MISMATCH', 403],
    ['EXTERNAL_CLIENT_AUTHORITY_REPLAY_DETECTED', 409],
    ['EXTERNAL_CLIENT_MUTATION_LOCAL_CANDIDATE_COLLISION', 409],
    ['EXTERNAL_CLIENT_PACKAGE_INVALID', 422],
    ['EXTERNAL_CLIENT_MUTATION_CANDIDATE_INVALID', 422],
    ['EXTERNAL_CLIENT_IDENTITY_REQUIRED', 503],
    ['EXTERNAL_CLIENT_MUTATION_OUTCOME_UNKNOWN', 503],
    ['UNKNOWN_PRIVATE_CODE', 503],
  ];
  for (const [code, status] of cases) {
    let calls = 0;
    const result = await adapterWith(async () => {
      calls += 1;
      const error = new Error('secret-message');
      error.code = code;
      error.details = { secret: 'private' };
      throw error;
    }).handle(requestFor(jsonEnvelope()));
    assertFailure(result, status);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  let getterCalls = 0;
  const result = await adapterWith(async () => {
    const error = new Error('hidden');
    Object.defineProperty(error, 'code', { get() { getterCalls += 1; return 'EXTERNAL_CLIENT_SIGNATURE_INVALID'; } });
    throw error;
  }).handle(requestFor(jsonEnvelope()));
  assertFailure(result, 503);
  assert.equal(getterCalls, 0);
});
test('success maps only six safe fields to immutable 201 and replayed 200 descriptors', async () => {
  for (const replayed of [false, true]) {
    const result = await adapterWith(async () => success(replayed, { secret: 'not-exposed' }))
      .handle(requestFor(jsonEnvelope()));
    assert.equal(result.statusCode, replayed ? 200 : 201);
    assert.deepEqual(Object.keys(result), ['statusCode', 'headers', 'body']);
    assert.deepEqual(Object.keys(result.headers), ['Content-Type', 'Cache-Control']);
    assert.deepEqual(Object.keys(result.body), ['ok', 'outcome', 'replayed', 'operationId', 'localCandidateId', 'receiptId']);
    assert.ok([result, result.headers, result.body].every(Object.isFrozen));
    assert.deepEqual([result.body.outcome, JSON.stringify(result).includes('not-exposed')], ['pending_review', false]);
    assert.throws(() => { result.body.ok = false; }, TypeError); assert.throws(() => { result.headers.extra = 'x'; }, TypeError);
  }
});
test('truthy, partial, mutable, accessor-backed and inconsistent success values fail as 503', async () => {
  const mutable = success();
  const mutableTop = { ...mutable };
  const mutableAdmission = Object.freeze({ ...mutable, admission: { ...mutable.admission } });
  const accessorAdmission = {};
  Object.defineProperty(accessorAdmission, 'ok', { enumerable: true, get() { throw new Error('getter'); } });
  Object.freeze(accessorAdmission);
  const malformed = [
    true, Object.freeze({ ok: true }), mutableTop, mutableAdmission,
    Object.freeze({ ...mutable, admission: Object.freeze({ ...mutable.admission, outcome: 'allow' }) }),
    Object.freeze({ ...mutable, admission: Object.freeze({ ...mutable.admission, operationId: 'x'.repeat(257) }) }),
    Object.freeze({ ...mutable, admission: accessorAdmission }),
  ];
  for (const value of malformed) {
    let calls = 0;
    const result = await adapterWith(async () => { calls += 1; return value; }).handle(requestFor(jsonEnvelope()));
    assertFailure(result, 503);
    assert.equal(calls, 1);
  }
});
test('module remains isolated while production boundary owns the route and package reachability', () => {
  const source = fs.readFileSync(path.join(__dirname, 'external-client-http-adapter.js'), 'utf8');
  assert.ok(source.split('\n').length - 1 <= 300);
  const imports = [...source.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./external-client-endpoint-contract', '../requestGuards']);
  assert.doesNotMatch(source, /require\(['"].*(sdk|external-client-authority|external-client-trust-config|external-client-replay-store|external-client-mutation-receipt-owner|graph|kernel|storage|server)/i);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /\/api\/external-client\/packages\/admit|external-client-http-adapter/);
  assert.match(server, /external-client-production-boundary/);
  const packed = JSON.parse(execFileSync(
    process.platform === 'win32' ? process.env.ComSpec : 'npm',
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts']
      : ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  }));
  const files = packed.flatMap((entry) => entry.files || []).map((entry) => entry.path);
  assert.equal(files.includes('lib/external-client-http-adapter.js'), true);
  assert.equal(files.includes('lib/external-client-production-boundary.js'), true);
});
