'use strict';

/**
 * The production MCP client envelope (#3997, #3999): conformance against the
 * committed vectors, the durable nonce path, and the bounds the spec fixes.
 *
 * The reference verifier lives in scripts/generate-mcp-client-envelope-vectors.js;
 * test/mcp-client-envelope-vectors.test.js pins the vectors themselves. This
 * file pins the *production* implementation: the same vectors must produce the
 * same answers here, and the durable nonce store must refuse what the vector
 * set's consumed-list stands in for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const envelope = require('../lib/mcp/client-envelope');
const { createDurableCapabilityNonceStore } = require('../lib/mcp-capability-nonce-store');
const { vectors, verifyEnvelope: referenceVerify, MAX_CLOCK_SKEW_MS: REFERENCE_SKEW_MS, ENVELOPE_VERSION } = require('../scripts/generate-mcp-client-envelope-vectors');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-envelope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the production verifier answers the reference on every committed vector', () => {
  for (const [name, vector] of Object.entries(vectors())) {
    assert.deepEqual(envelope.verifyClientEnvelope(vector.envelope, vector.call, vector.enrolled),
      referenceVerify(vector.envelope, vector.call, vector.enrolled), name);
  }
});

test('sign and verify round-trip through a real keypair and a real nonce store', (t) => {
  const dir = tempDir(t);
  const store = createDurableCapabilityNonceStore({ directory: path.join(dir, 'nonces') });
  const { privateKey, keyId, publicKeyBase64url } = envelope.createClientKey();
  const enrolled = [{ client_id: 'agent-x', key_id: keyId, public_key: publicKeyBase64url }];
  const created = envelope.createClientEnvelope({
    client_id: 'agent-x', workspace_id: '0123456789abcdef', op: 'tools/call',
    args: { name: 'huqan.ask', arguments: { question: 'kedi' } },
  }, privateKey);
  const call = {
    client_id: 'agent-x', workspace_id: '0123456789abcdef', op: 'tools/call',
    args: { name: 'huqan.ask', arguments: { question: 'kedi' } }, now: created.issued_at,
  };
  assert.deepEqual(envelope.verifyClientEnvelope(created, call, enrolled, { nonceStore: store }),
    { ok: true, payload: { client_id: 'agent-x', workspace_id: '0123456789abcdef', op: 'tools/call' } });
});

test('a nonce is single-use across calls through the durable store', (t) => {
  const dir = tempDir(t);
  const store = createDurableCapabilityNonceStore({ directory: path.join(dir, 'nonces') });
  const { privateKey, keyId, publicKeyBase64url } = envelope.createClientKey();
  const enrolled = [{ client_id: 'agent-x', key_id: keyId, public_key: publicKeyBase64url }];
  const created = envelope.createClientEnvelope({ client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {} }, privateKey);
  const call = (now) => ({ client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {}, now });
  const first = envelope.verifyClientEnvelope(created, call(created.issued_at), enrolled, { nonceStore: store });
  assert.equal(first.ok, true);
  const second = envelope.verifyClientEnvelope(created, call(created.issued_at), enrolled, { nonceStore: store });
  assert.deepEqual(second, { ok: false, code: 'replayed' });
});

test('an unrecordable nonce store refuses instead of accepting', (t) => {
  const dir = tempDir(t);
  // A file where the store's directory must be: mkdirSync fails, consume
  // returns false, and the request is refused.
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const store = createDurableCapabilityNonceStore({ directory: path.join(blocker, 'nonces') });
  const { privateKey, keyId, publicKeyBase64url } = envelope.createClientKey();
  const enrolled = [{ client_id: 'agent-x', key_id: keyId, public_key: publicKeyBase64url }];
  const created = envelope.createClientEnvelope({ client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {} }, privateKey);
  const verdict = envelope.verifyClientEnvelope(created,
    { client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {}, now: created.issued_at }, enrolled, { nonceStore: store });
  assert.deepEqual(verdict, { ok: false, code: 'replayed' });
  void dir;
});

test('freshness edges: not yet valid before issued_at, expired at expires_at', (t) => {
  const { privateKey, keyId, publicKeyBase64url } = envelope.createClientKey();
  const enrolled = [{ client_id: 'agent-x', key_id: keyId, public_key: publicKeyBase64url }];
  const created = envelope.createClientEnvelope({
    client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {},
    now: '2026-01-01T00:00:00.000Z', ttlMs: 60000,
  }, privateKey);
  const call = (now) => ({ client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {}, now, consumed_nonces: [] });
  assert.equal(envelope.verifyClientEnvelope(created, call('2025-12-31T23:59:50.000Z'), enrolled).code, 'not_yet_valid');
  assert.equal(envelope.verifyClientEnvelope(created, call('2026-01-01T00:01:00.000Z'), enrolled).code, 'expired');
  assert.equal(envelope.verifyClientEnvelope(created, call('2026-01-01T00:00:59.999Z'), enrolled).ok, true);
});

test('the signature binds the envelope: one flipped byte refuses', (t) => {
  const { privateKey, keyId, publicKeyBase64url } = envelope.createClientKey();
  const enrolled = [{ client_id: 'agent-x', key_id: keyId, public_key: publicKeyBase64url }];
  const created = envelope.createClientEnvelope({ client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {} }, privateKey);
  const bytes = Buffer.from(created.sig, 'base64url');
  bytes[10] ^= 0x01;
  const verdict = envelope.verifyClientEnvelope({ ...created, sig: bytes.toString('base64url') },
    { client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {}, now: created.issued_at }, enrolled);
  assert.deepEqual(verdict, { ok: false, code: 'signature_invalid' });
});

test('a key not enrolled for the client is unknown, and an unknown field is malformed', (t) => {
  const { privateKey, keyId, publicKeyBase64url } = envelope.createClientKey();
  const enrolled = [{ client_id: 'agent-y', key_id: keyId, public_key: publicKeyBase64url }];
  const created = envelope.createClientEnvelope({ client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {} }, privateKey);
  const call = { client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {}, now: created.issued_at };
  assert.equal(envelope.verifyClientEnvelope(created, call, enrolled).code, 'unknown_key');
  assert.equal(envelope.verifyClientEnvelope({ ...created, extra: 1 }, call, [{ client_id: 'agent-x', key_id: keyId, public_key: publicKeyBase64url }]).code,
    'malformed');
});

test('the builder refuses a ttl over the window and unbounded fields', () => {
  const { privateKey } = envelope.createClientKey();
  assert.throws(() => envelope.createClientEnvelope({ client_id: 'a', workspace_id: 'w', op: 'x', args: {}, ttlMs: 60001 }, privateKey), /ttlMs/);
  assert.throws(() => envelope.createClientEnvelope({ client_id: '', workspace_id: 'w', op: 'x', args: {} }, privateKey), /client_id/);
  assert.throws(() => envelope.createClientEnvelope({ client_id: 'a', workspace_id: 'w', op: 'x'.repeat(513), args: {} }, privateKey), /op/);
});

test('the args digest is canonical: key order does not change it', () => {
  assert.equal(envelope.argsSha256({ b: 2, a: 1 }), envelope.argsSha256({ a: 1, b: 2 }));
});

test('the envelope version constant matches the specification', () => {
  assert.equal(ENVELOPE_VERSION, 'huqan.mcp.envelope.v1');
  assert.equal(envelope.ENVELOPE_VERSION, 'huqan.mcp.envelope.v1');
});

test('refusal messages are bounded and fixed per code', () => {
  for (const code of envelope.CODES) {
    const message = envelope.refusalMessage(code);
    assert.ok(typeof message === 'string' && message.length > 0 && message.length <= 200, code);
  }
  assert.equal(envelope.refusalMessage('nonexistent'), 'the envelope was refused');
});

test('clock skew: a not-before within MAX_CLOCK_SKEW_MS is accepted, beyond it is not_yet_valid, and expiry gets no allowance', () => {
  const { privateKey, keyId, publicKeyBase64url } = envelope.createClientKey();
  const enrolled = [{ client_id: 'agent-x', key_id: keyId, public_key: publicKeyBase64url }];
  const issuedAt = Date.parse('2026-01-01T00:00:00.000Z');
  const created = envelope.createClientEnvelope({
    client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {}, now: new Date(issuedAt), ttlMs: 60000,
  }, privateKey);
  const verify = (nowMs, store) => envelope.verifyClientEnvelope(created, {
    client_id: 'agent-x', workspace_id: 'w', op: 'tools/list', args: {}, now: new Date(nowMs).toISOString(), consumed_nonces: [],
  }, enrolled, store ? { nonceStore: store } : {});
  const skew = envelope.MAX_CLOCK_SKEW_MS;
  assert.ok(skew >= 1000 && skew <= 10000, 'a few seconds, not minutes');
  assert.equal(verify(issuedAt - skew + 1000).ok, true, 'the verifier clock 1 s inside the allowance');
  assert.equal(verify(issuedAt - skew).ok, true, 'exactly at the allowance');
  assert.equal(verify(issuedAt - skew - 1).code, 'not_yet_valid', 'one millisecond beyond the allowance');
  assert.equal(verify(issuedAt + 60000).code, 'expired', 'the window closes at expires_at, with no skew added');
  assert.equal(verify(issuedAt + 60000 - 1).ok, true);
  assert.equal(envelope.MAX_CLOCK_SKEW_MS, REFERENCE_SKEW_MS, 'the reference verifier and the production verifier agree');
});
