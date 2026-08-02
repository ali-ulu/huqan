'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('./receipt/canonical-receipt');
const {
  EXTERNAL_CLIENT_AUTHORITY_VERSION,
  EXTERNAL_CLIENT_ADMISSION_PERMISSION,
  EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS,
  EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS,
  EXTERNAL_CLIENT_REPLAY_TTL_MS,
  EXTERNAL_CLIENT_AUTHORITY_ERRORS: E,
  enforceExternalClientAuthority,
  snapshotExternalClientAuthority,
} = require('./external-client-authority');

const NOW = Date.parse('2026-08-02T12:00:00.000Z');
const COLLECTIONS = ['provenanceRecords', 'auditEvents', 'candidateClaims', 'conflictResults',
  'verificationResults', 'trustReceipts', 'causalChains', 'simulationResults'];
function pkg(createdAt = '2026-08-02T11:59:00.000Z') {
  const objectCounts = {}; const objects = {};
  for (const name of COLLECTIONS) { objectCounts[name] = 0; objects[name] = []; }
  return { manifest: { packageId: 'pkg.github.workspace-a', format: 'axiom-package', formatVersion: '0.1',
    createdAt, createdBy: 'connector:github', workspaceId: 'workspace-a', description: 'Authority fixture',
    atpVersion: '0.1', objectCounts }, objects,
  index: { byId: {}, bySourceRef: {}, byWorkspaceId: {}, byType: {} }, metadata: { warnings: [] } };
}
function sign(value, privateKey) {
  return { algorithm: 'ed25519', keyId: 'trusted-key-1',
    value: crypto.sign(null, Buffer.from(stableStringify(value), 'utf8'), privateKey).toString('base64') };
}
function input(value, privateKey, extra = {}) {
  return { identity: { subject: 'connector:github', kind: 'connector' }, workspaceId: 'workspace-a',
    package: value, signature: sign(value, privateKey), ...extra };
}
function replayStore(result = null) {
  const seen = new Set(); const calls = [];
  return { calls, reserve(record) { calls.push(record); if (result) return result(record);
    if (seen.has(record.replayKey)) return { reserved: false, existing: { replayKey: record.replayKey } };
    seen.add(record.replayKey); return { reserved: true }; } };
}
function options(publicKey, extra = {}) {
  return { expectedIdentitySubject: 'connector:github', expectedIdentityKind: 'connector',
    expectedWorkspaceId: 'workspace-a', expectedPackageId: 'pkg.github.workspace-a',
    permissions: [EXTERNAL_CLIENT_ADMISSION_PERMISSION], trustedKeys: { 'trusted-key-1': {
      publicKey, workspaceId: 'workspace-a', packageIds: ['pkg.github.workspace-a'],
      identitySubjects: ['connector:github'], identityKinds: ['connector'],
      notBefore: '2026-08-02T11:00:00.000Z', notAfter: '2026-08-02T13:00:00.000Z', revoked: false } },
    clock: () => NOW, replayStore: replayStore(), ...extra };
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error.code === code);
}
function throwsCode(fn, code) { assert.throws(fn, (error) => error.code === code); }

test('exact authority allows once, reserves before return and exposes frozen secret-free evidence', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const store = replayStore();
  const result = await enforceExternalClientAuthority(input(pkg(), privateKey),
    snapshotExternalClientAuthority(options(publicKey, { replayStore: store })));
  assert.equal(result.ok, true); assert.equal(result.decision, 'allow');
  assert.equal(result.authorityVersion, EXTERNAL_CLIENT_AUTHORITY_VERSION);
  assert.equal(result.permission, EXTERNAL_CLIENT_ADMISSION_PERMISSION);
  assert.equal(result.trustedKeyId, 'trusted-key-1'); assert.equal(store.calls.length, 1);
  assert.equal(result.expiresAt - result.reservedAt, EXTERNAL_CLIENT_REPLAY_TTL_MS);
  assert.match(result.replayKey, /^external-client-authority-0-v1:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.authorityReceipt), true);
  assert.equal(Object.isFrozen(store.calls[0]), true);
  for (const value of Object.values(store.calls[0])) assert.notEqual(typeof value, 'function');
  assert.equal('publicKey' in result, false); assert.equal('replayStore' in result, false);
});

test('verified identity must exactly match authoritative subject and kind before replay', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  for (const patch of [{ expectedIdentitySubject: 'connector:other' }, { expectedIdentityKind: 'service' }]) {
    const store = replayStore();
    await rejectsCode(enforceExternalClientAuthority(input(pkg(), privateKey),
      snapshotExternalClientAuthority(options(publicKey, { ...patch, replayStore: store }))), E.IDENTITY_MISMATCH);
    assert.equal(store.calls.length, 0);
  }
});

test('missing, unknown, duplicate, inherited, accessor-backed and symbol permissions fail closed', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const cases = [undefined, [], ['other'], ['package:admit', 'package:admit']];
  for (const permissions of cases) {
    const value = options(publicKey); if (permissions === undefined) delete value.permissions; else value.permissions = permissions;
    throwsCode(() => snapshotExternalClientAuthority(value), E.PERMISSION_REQUIRED);
  }
  const inherited = Object.create(['package:admit']);
  const accessor = []; Object.defineProperty(accessor, '0', { get() { throw new Error('getter'); } }); accessor.length = 1;
  const symbolic = ['package:admit']; symbolic[Symbol('permission')] = 'package:admit';
  for (const permissions of [inherited, accessor, symbolic]) {
    throwsCode(() => snapshotExternalClientAuthority(options(publicKey, { permissions })), E.PERMISSION_REQUIRED);
  }
});

test('authority requires exact strings, trusted clock and atomic replay owner at snapshot time', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  for (const field of ['expectedIdentitySubject', 'expectedIdentityKind', 'expectedWorkspaceId', 'expectedPackageId']) {
    const value = options(publicKey); delete value[field];
    throwsCode(() => snapshotExternalClientAuthority(value), E.AUTHORITY_REQUIRED);
  }
  throwsCode(() => snapshotExternalClientAuthority(options(publicKey, { clock: null })), E.CLOCK_INVALID);
  throwsCode(() => snapshotExternalClientAuthority(options(publicKey, { replayStore: {} })), E.REPLAY_OWNER_REQUIRED);
});

test('trusted keys require public material, exact scope, validity interval and explicit non-revocation', () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const mutations = [
    [entry => { delete entry.notBefore; }, E.KEY_INVALID],
    [entry => { entry.notAfter = entry.notBefore; }, E.KEY_INVALID],
    [entry => { delete entry.revoked; }, E.KEY_INVALID],
    [entry => { entry.revoked = true; }, E.KEY_REVOKED],
    [entry => { entry.packageIds = []; }, E.KEY_INVALID],
    [entry => { entry.publicKey = keys.privateKey; }, E.KEY_INVALID],
  ];
  for (const [mutate, code] of mutations) {
    const value = options(keys.publicKey); mutate(value.trustedKeys['trusted-key-1']);
    throwsCode(() => snapshotExternalClientAuthority(value), code);
  }
  const collision = options(keys.publicKey);
  collision.trustedKeys[' trusted-key-1 '] = { ...collision.trustedKeys['trusted-key-1'] };
  throwsCode(() => snapshotExternalClientAuthority(collision), E.KEY_INVALID);
});

test('revocation and permission accessors are rejected without invocation', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519'); let calls = 0;
  const value = options(publicKey); delete value.trustedKeys['trusted-key-1'].revoked;
  Object.defineProperty(value.trustedKeys['trusted-key-1'], 'revoked', { get() { calls += 1; return false; } });
  throwsCode(() => snapshotExternalClientAuthority(value), E.KEY_INVALID); assert.equal(calls, 0);
});

test('key validity is checked against both signed creation time and trusted clock', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const cases = [
    { notBefore: '2026-08-02T12:01:00.000Z', notAfter: '2026-08-02T13:00:00.000Z' },
    { notBefore: '2026-08-02T10:00:00.000Z', notAfter: '2026-08-02T11:59:30.000Z' },
  ];
  for (const interval of cases) {
    const value = options(publicKey); Object.assign(value.trustedKeys['trusted-key-1'], interval);
    await rejectsCode(enforceExternalClientAuthority(input(pkg(), privateKey), snapshotExternalClientAuthority(value)), E.KEY_INVALID);
  }
});

test('signed createdAt rejects non-canonical, stale and excessively future values before replay', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const cases = [
    ['2026-08-02T11:59:00Z', E.CREATED_AT_INVALID],
    [new Date(NOW - EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS - 1).toISOString(), E.STALE],
    [new Date(NOW + EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS + 1).toISOString(), E.FUTURE_DATED],
  ];
  for (const [createdAt, code] of cases) {
    const store = replayStore();
    await rejectsCode(enforceExternalClientAuthority(input(pkg(createdAt), privateKey),
      snapshotExternalClientAuthority(options(publicKey, { replayStore: store }))), code);
    assert.equal(store.calls.length, 0);
  }
});

test('clock throw and non-finite clock values fail before replay', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  for (const clock of [() => { throw new Error('clock'); }, () => Number.NaN]) {
    const store = replayStore();
    await rejectsCode(enforceExternalClientAuthority(input(pkg(), privateKey),
      snapshotExternalClientAuthority(options(publicKey, { clock, replayStore: store }))), E.CLOCK_INVALID);
    assert.equal(store.calls.length, 0);
  }
});

test('duplicate, throw, rejection and malformed replay results use bounded errors', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const cases = [
    [() => false, E.REPLAY_DETECTED], [() => ({ reserved: false }), E.REPLAY_DETECTED],
    [() => { throw new Error('db'); }, E.REPLAY_RESERVATION_FAILED],
    [async () => { throw new Error('db'); }, E.REPLAY_RESERVATION_FAILED],
    [() => true, E.REPLAY_RESERVATION_FAILED], [() => ({ reserved: true, extra: true }), E.REPLAY_RESERVATION_FAILED],
  ];
  for (const [reserve, code] of cases) {
    await rejectsCode(enforceExternalClientAuthority(input(pkg(), privateKey),
      snapshotExternalClientAuthority(options(publicKey, { replayStore: { reserve } }))), code);
  }
});

test('replay result classification accepts only canonical success and bounds hostile shapes', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  let getterCalls = 0;
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'reserved', { value: true, enumerable: false });
  const accessor = {};
  Object.defineProperty(accessor, 'reserved', { enumerable: true, get() { getterCalls += 1; return true; } });
  const symbolExtended = { reserved: true };
  symbolExtended[Symbol('extra')] = true;
  const extraField = { reserved: true, extra: true };
  const hostileProxies = [
    new Proxy({ reserved: true }, { getPrototypeOf() { throw new Error('prototype trap'); } }),
    new Proxy({ reserved: true }, { ownKeys() { throw new Error('keys trap'); } }),
    new Proxy({ reserved: true }, { getOwnPropertyDescriptor() { throw new Error('descriptor trap'); } }),
  ];

  for (const result of [nonEnumerable, accessor, symbolExtended, extraField, ...hostileProxies]) {
    await rejectsCode(enforceExternalClientAuthority(input(pkg(), privateKey),
      snapshotExternalClientAuthority(options(publicKey, { replayStore: { reserve: () => result } }))), E.REPLAY_RESERVATION_FAILED);
  }
  assert.equal(getterCalls, 0);

  const canonical = await enforceExternalClientAuthority(input(pkg(), privateKey),
    snapshotExternalClientAuthority(options(publicKey, { replayStore: { reserve: () => ({ reserved: true }) } })));
  assert.equal(canonical.ok, true);
  for (const result of [false, { reserved: false }, { existing: { replayKey: 'existing' } }]) {
    await rejectsCode(enforceExternalClientAuthority(input(pkg(), privateKey),
      snapshotExternalClientAuthority(options(publicKey, { replayStore: { reserve: () => result } }))), E.REPLAY_DETECTED);
  }
});

test('same signed evidence is replay-rejected and caller override fields cannot alter its key', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const store = replayStore();
  const authority = snapshotExternalClientAuthority(options(publicKey, { replayStore: store }));
  const value = pkg(); const signed = input(value, privateKey, { nonce: 'attacker', replayKey: 'attacker', issuedAt: '2099' });
  const first = await enforceExternalClientAuthority(signed, authority);
  assert.notEqual(first.replayKey, 'attacker');
  await rejectsCode(enforceExternalClientAuthority(signed, authority), E.REPLAY_DETECTED);
  assert.equal(store.calls[0].replayKey, store.calls[1].replayKey);
});

test('authority snapshots cannot be replaced through later option, key, clock or replay mutations', async () => {
  const trusted = crypto.generateKeyPairSync('ed25519'); const attacker = crypto.generateKeyPairSync('ed25519');
  const store = replayStore(); const value = options(trusted.publicKey, { replayStore: store });
  const authority = snapshotExternalClientAuthority(value);
  value.expectedIdentitySubject = 'attacker'; value.permissions[0] = 'other';
  value.trustedKeys['trusted-key-1'].publicKey = attacker.publicKey; value.clock = () => 0;
  value.replayStore.reserve = () => ({ reserved: false });
  const result = await enforceExternalClientAuthority(input(pkg(), trusted.privateKey), authority);
  assert.equal(result.identity.subject, 'connector:github'); assert.equal(store.calls.length, 1);
});

test('only genuine snapshots are accepted by the exported enforcement function', async () => {
  await rejectsCode(enforceExternalClientAuthority({ package: {} }, Object.freeze({})), E.AUTHORITY_REQUIRED);
});

test('trusted key entries reject privateKey, unknown, symbol, inherited and accessor-backed fields', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const { privateKey: attackerPrivateKey } = crypto.generateKeyPairSync('ed25519');
  const bases = [
    (entry) => { entry.privateKey = attackerPrivateKey; },
    (entry) => { entry.unknownField = 'x'; },
    (entry) => { entry[Symbol('trap')] = 'x'; },
    (entry) => { Object.defineProperty(entry, 'extra', { get() { throw new Error('must not read'); }, enumerable: true }); },
  ];
  for (const mutate of bases) {
    const value = options(publicKey);
    mutate(value.trustedKeys['trusted-key-1']);
    throwsCode(() => snapshotExternalClientAuthority(value), E.KEY_INVALID);
  }
  const inheritedProto = { inheritedField: 'x' };
  const value = options(publicKey);
  const inheritedEntry = Object.assign(Object.create(inheritedProto), value.trustedKeys['trusted-key-1']);
  value.trustedKeys['trusted-key-1'] = inheritedEntry;
  throwsCode(() => snapshotExternalClientAuthority(value), E.KEY_INVALID);
});

test('a getter or proxy cannot present a different createdAt to freshness than the signed package', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signedPackage = pkg('2026-08-02T11:59:00.000Z');
  const signature = sign(signedPackage, privateKey);
  let reads = 0;
  const deceptivePackage = new Proxy(signedPackage, {
    get(target, key, receiver) {
      if (key === 'manifest') {
        return new Proxy(target.manifest, {
          get(manifestTarget, manifestKey, manifestReceiver) {
            if (manifestKey === 'createdAt') {
              reads += 1;
              return reads > 1
                ? new Date(NOW + EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS + 1000).toISOString()
                : Reflect.get(manifestTarget, manifestKey, manifestReceiver);
            }
            return Reflect.get(manifestTarget, manifestKey, manifestReceiver);
          },
        });
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const store = replayStore();
  const authority = snapshotExternalClientAuthority(options(publicKey, { replayStore: store }));
  const result = await enforceExternalClientAuthority(
    { identity: { subject: 'connector:github', kind: 'connector' }, workspaceId: 'workspace-a', package: deceptivePackage, signature },
    authority,
  );
  assert.equal(result.createdAt, '2026-08-02T11:59:00.000Z');
});

test('the exported authority API fails closed when it cannot own a deterministic package snapshot', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const authority = snapshotExternalClientAuthority(options(publicKey));
  const cases = [
    (value) => { value.metadata.circular = value; },
    (value) => { value.metadata.value = undefined; },
    (value) => { value.metadata.value = () => {}; },
    (value) => { value.metadata.value = 1n; },
    (value) => { value.metadata.value = Number.NaN; },
    (value) => { value.metadata[Symbol('hidden')] = true; },
    (value) => { Object.defineProperty(value.metadata, 'hidden', { value: true, enumerable: false }); },
    (value) => { Object.defineProperty(value.metadata, 'trap', { get() { throw new Error('must not invoke'); }, enumerable: true }); },
    (value) => { Object.defineProperty(value.metadata, '__proto__', { value: { polluted: true }, enumerable: true }); },
    (value) => { value.metadata.value = new Array(0xffffffff); },
  ];

  for (const mutate of cases) {
    const invalidPackage = pkg();
    mutate(invalidPackage);
    await rejectsCode(
      enforceExternalClientAuthority({ package: invalidPackage }, authority),
      'EXTERNAL_CLIENT_PACKAGE_INVALID',
    );
  }
});

test('Authority-0 remains isolated from server, kernel, graph, storage and environment state', () => {
  const source = fs.readFileSync(path.join(__dirname, 'external-client-authority.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:\.\.\/)?(?:server|kernel|graph|memory-store)/);
  assert.doesNotMatch(source, /process\.env/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /\/api\/external-client\/packages\/admit/);
  assert.doesNotMatch(server, /external-client-authority|external-client-package-gate|admitExternalPackage/);
});
