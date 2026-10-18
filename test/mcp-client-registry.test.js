'use strict';

/**
 * The enrolled-client registry (ADR-018 §4, spec §5): key-id derivation is
 * enforced at enrolment, rotation is bounded, revocation takes effect on the
 * next read, and an unreadable registry is not-ok, never silently empty.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('../lib/mcp/client-registry');
const { createClientKey, keyIdFromRaw, rawPublicKeyBase64url } = require('../lib/mcp/client-envelope');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recordFor(clientId, key) {
  return { client_id: clientId, key_id: key.keyId, public_key: key.publicKeyBase64url };
}

test('an absent registry reads as enrolled-nobody, which refuses everything', () => {
  const read = registry.readClientRegistry(path.join(os.tmpdir(), `huqan-registry-absent-${process.pid}`, 'clients.json'));
  assert.deepEqual(read, { ok: true, clients: [] });
});

test('a malformed or unreadable registry is not-ok, not an empty registry', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'clients.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(registry.readClientRegistry(file), { ok: false, reason: 'registry_malformed' });
  fs.writeFileSync(file, `${JSON.stringify({ v: 'wrong', clients: [] })}\n`);
  assert.equal(registry.readClientRegistry(file).ok, false);
  // A record whose key_id disagrees with its public key is malformed by rule.
  const key = createClientKey();
  const bad = { client_id: 'a', key_id: 'ffffffffffffffff', public_key: key.publicKeyBase64url };
  fs.writeFileSync(file, `${JSON.stringify({ v: registry.REGISTRY_VERSION, clients: [bad] })}\n`);
  assert.deepEqual(registry.readClientRegistry(file), { ok: false, reason: 'registry_malformed' });
});

test('a record whose key_id does not derive from its public key is refused at enrolment', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'clients.json');
  const key = createClientKey();
  const upserted = registry.upsertClientRecord(file, { client_id: 'agent-x', key_id: 'aaaaaaaaaaaaaaaa', public_key: key.publicKeyBase64url });
  assert.deepEqual(upserted, { ok: false, reason: 'key_id_mismatch' });
  assert.equal(fs.existsSync(file), false, 'nothing was written');
});

test('rotation allows the overlap pair and then refuses a third key', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'clients.json');
  const first = createClientKey();
  const second = createClientKey();
  const third = createClientKey();
  assert.equal(registry.upsertClientRecord(file, recordFor('agent-x', first)).ok, true);
  assert.equal(registry.upsertClientRecord(file, recordFor('agent-x', second)).ok, true);
  assert.deepEqual(registry.upsertClientRecord(file, recordFor('agent-x', third)), { ok: false, reason: 'rotation_overlap_full' });
  // A different client enrols independently.
  assert.equal(registry.upsertClientRecord(file, recordFor('agent-y', third)).ok, true);
});

test('a key_id can never be reused, even for another client', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'clients.json');
  const key = createClientKey();
  assert.equal(registry.upsertClientRecord(file, recordFor('agent-x', key)).ok, true);
  assert.deepEqual(registry.upsertClientRecord(file, { ...recordFor('agent-y', key), client_id: 'agent-y' }),
    { ok: false, reason: 'key_id_reused' });
});

test('revocation removes exactly one record and takes effect on the next read', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'clients.json');
  const oldKey = createClientKey();
  const newKey = createClientKey();
  registry.upsertClientRecord(file, recordFor('agent-x', oldKey));
  registry.upsertClientRecord(file, recordFor('agent-x', newKey));
  const removed = registry.removeClientRecord(file, { client_id: 'agent-x', key_id: oldKey.keyId });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.clients.map((r) => r.key_id), [newKey.keyId]);
  assert.deepEqual(registry.removeClientRecord(file, { client_id: 'agent-x', key_id: oldKey.keyId }),
    { ok: false, reason: 'record_absent' });
});

test('the derived key id is the same 16 hex the authority vocabulary uses', () => {
  const key = createClientKey();
  const raw = Buffer.from(key.publicKeyBase64url, 'base64url');
  assert.equal(key.keyId, keyIdFromRaw(raw));
  assert.match(key.keyId, /^[0-9a-f]{16}$/);
  assert.equal(key.publicKeyBase64url, rawPublicKeyBase64url(key.privateKey));
});
