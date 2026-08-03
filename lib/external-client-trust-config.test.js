'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  EXTERNAL_CLIENT_ADMISSION_PERMISSION,
  EXTERNAL_CLIENT_AUTHORITY_ERRORS: E,
  snapshotExternalClientAuthority,
} = require('./external-client-authority');
const {
  EXTERNAL_CLIENT_TRUST_CONFIG_VERSION,
  EXTERNAL_CLIENT_MAX_TRUSTED_KEYS,
  materializeExternalClientTrustConfig,
} = require('./external-client-trust-config');

function keyBytes() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'der', type: 'spki' });
}

function keyEntry(bytes = keyBytes(), extra = {}) {
  return {
    publicKeySpkiDer: bytes,
    workspaceId: 'workspace-a',
    packageIds: ['pkg.github.workspace-a'],
    identitySubjects: ['connector:github'],
    identityKinds: ['connector'],
    notBefore: '2026-08-02T11:00:00.000Z',
    notAfter: '2026-08-02T13:00:00.000Z',
    revoked: false,
    ...extra,
  };
}

function profile(extra = {}) {
  return {
    profileVersion: EXTERNAL_CLIENT_TRUST_CONFIG_VERSION,
    expectedIdentitySubject: 'connector:github',
    expectedIdentityKind: 'connector',
    expectedWorkspaceId: 'workspace-a',
    expectedPackageId: 'pkg.github.workspace-a',
    permissions: [EXTERNAL_CLIENT_ADMISSION_PERMISSION],
    trustedKeys: { 'trusted-key-1': keyEntry() },
    ...extra,
  };
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

function exportedDer(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' });
}

test('one-key profile produces a frozen deterministic secret-free snapshot', () => {
  const bytes = keyBytes();
  const input = profile({ trustedKeys: { 'trusted-key-1': keyEntry(bytes) } });
  const first = materializeExternalClientTrustConfig(input);
  const second = materializeExternalClientTrustConfig(input);

  assert.equal(first.profileVersion, EXTERNAL_CLIENT_TRUST_CONFIG_VERSION);
  assert.equal(first.expectedIdentitySubject, 'connector:github');
  assert.deepEqual(first.permissions, ['package:admit']);
  assert.deepEqual(Object.keys(first.trustedKeys), ['trusted-key-1']);
  assert.equal(first.trustedKeys['trusted-key-1'].publicKey.type, 'public');
  assert.equal(first.trustedKeys['trusted-key-1'].publicKey.asymmetricKeyType, 'ed25519');
  assert.equal(Object.isFrozen(first.trustedKeys['trusted-key-1'].publicKey), true);
  assert.deepEqual(
    exportedDer(first.trustedKeys['trusted-key-1'].publicKey),
    exportedDer(second.trustedKeys['trusted-key-1'].publicKey),
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.permissions), true);
  assert.equal(Object.isFrozen(first.trustedKeys), true);
  assert.equal(Object.isFrozen(first.trustedKeys['trusted-key-1']), true);
  assert.equal('publicKeySpkiDer' in first.trustedKeys['trusted-key-1'], false);
  assert.equal('privateKey' in first, false);
});

test('materialized profile composes with the existing Authority-0 snapshot boundary', () => {
  const materialized = materializeExternalClientTrustConfig(profile());
  const authority = snapshotExternalClientAuthority({
    ...materialized,
    clock: () => Date.parse('2026-08-02T12:00:00.000Z'),
    replayStore: { reserve() { return { reserved: true }; } },
  });
  assert.equal(authority.expectedIdentitySubject, 'connector:github');
  assert.equal(authority.expectedWorkspaceId, 'workspace-a');
  assert.deepEqual(Object.keys(authority.trustedKeys), ['trusted-key-1']);
  assert.equal(authority.trustedKeys['trusted-key-1'].publicKey.asymmetricKeyType, 'ed25519');
});

test('two-key restart rotation is accepted and normalized deterministically', () => {
  const input = profile({
    trustedKeys: {
      'trusted-key-z': keyEntry(),
      ' trusted-key-a ': keyEntry(),
    },
  });
  const snapshot = materializeExternalClientTrustConfig(input);
  assert.equal(EXTERNAL_CLIENT_MAX_TRUSTED_KEYS, 2);
  assert.deepEqual(Object.keys(snapshot.trustedKeys), ['trusted-key-a', 'trusted-key-z']);
});

test('zero, three-key and hostile oversized rosters fail closed without reading entries', () => {
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: {} })),
    E.KEY_INVALID,
  );
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({
      trustedKeys: {
        a: keyEntry(),
        b: keyEntry(),
        c: keyEntry(),
      },
    })),
    E.KEY_INVALID,
  );
  let calls = 0;
  const hostile = { a: keyEntry(), b: keyEntry() };
  Object.defineProperty(hostile, 'c', {
    enumerable: true,
    get() { calls += 1; throw new Error('third entry getter'); },
  });
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: hostile })),
    E.KEY_INVALID,
  );
  assert.equal(calls, 0);
});

test('roster bound cannot be widened or supplied by the profile', () => {
  const value = profile();
  value.maxTrustedKeys = 99;
  throwsCode(() => materializeExternalClientTrustConfig(value), E.AUTHORITY_REQUIRED);
});

test('later mutation of root, arrays, entries and source bytes cannot alter output', () => {
  const backing = Buffer.alloc(80, 0x7f);
  const der = keyBytes();
  der.copy(backing, 13);
  const visible = new Uint8Array(backing.buffer, backing.byteOffset + 13, der.length);
  const input = profile({ trustedKeys: { key: keyEntry(visible) } });
  const snapshot = materializeExternalClientTrustConfig(input);
  const before = exportedDer(snapshot.trustedKeys.key.publicKey);

  input.expectedWorkspaceId = 'workspace-b';
  input.permissions[0] = 'other';
  input.trustedKeys.key.workspaceId = 'workspace-b';
  input.trustedKeys.key.packageIds[0] = 'other';
  visible.fill(0);

  assert.equal(snapshot.expectedWorkspaceId, 'workspace-a');
  assert.deepEqual(snapshot.permissions, ['package:admit']);
  assert.equal(snapshot.trustedKeys.key.workspaceId, 'workspace-a');
  assert.deepEqual(snapshot.trustedKeys.key.packageIds, ['pkg.github.workspace-a']);
  assert.deepEqual(exportedDer(snapshot.trustedKeys.key.publicKey), before);
});

test('root requires the exact own enumerable data-property shape', () => {
  const missing = profile();
  delete missing.expectedPackageId;
  throwsCode(() => materializeExternalClientTrustConfig(missing), E.AUTHORITY_REQUIRED);

  const unknown = profile();
  unknown.extra = true;
  throwsCode(() => materializeExternalClientTrustConfig(unknown), E.AUTHORITY_REQUIRED);

  const symbolic = profile();
  symbolic[Symbol('root')] = true;
  throwsCode(() => materializeExternalClientTrustConfig(symbolic), E.AUTHORITY_REQUIRED);

  const accessor = profile();
  delete accessor.expectedWorkspaceId;
  Object.defineProperty(accessor, 'expectedWorkspaceId', {
    enumerable: true,
    get() { throw new Error('root getter'); },
  });
  throwsCode(() => materializeExternalClientTrustConfig(accessor), E.AUTHORITY_REQUIRED);

  const nonEnumerable = profile();
  Object.defineProperty(nonEnumerable, 'expectedWorkspaceId', {
    value: 'workspace-a',
    enumerable: false,
  });
  throwsCode(() => materializeExternalClientTrustConfig(nonEnumerable), E.AUTHORITY_REQUIRED);

  const inherited = Object.assign(Object.create({ surprise: true }), profile());
  throwsCode(() => materializeExternalClientTrustConfig(inherited), E.AUTHORITY_REQUIRED);
});

test('profile version and authoritative strings fail closed when missing or invalid', () => {
  for (const patch of [
    { profileVersion: 'other' },
    { expectedIdentitySubject: '' },
    { expectedIdentityKind: null },
    { expectedWorkspaceId: '   ' },
    { expectedPackageId: 1 },
  ]) {
    throwsCode(() => materializeExternalClientTrustConfig(profile(patch)), E.AUTHORITY_REQUIRED);
  }
});

test('permission is exactly one own package:admit string', () => {
  for (const permissions of [[], ['other'], ['package:admit', 'package:admit']]) {
    throwsCode(() => materializeExternalClientTrustConfig(profile({ permissions })), E.PERMISSION_REQUIRED);
  }
  const accessor = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() { throw new Error('permission getter'); },
  });
  accessor.length = 1;
  throwsCode(() => materializeExternalClientTrustConfig(profile({ permissions: accessor })), E.PERMISSION_REQUIRED);

  const extended = ['package:admit'];
  extended.extra = true;
  throwsCode(() => materializeExternalClientTrustConfig(profile({ permissions: extended })), E.PERMISSION_REQUIRED);
});

test('key IDs reject empty, normalization collision, symbols and hostile descriptors', () => {
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: { ' ': keyEntry() } })),
    E.KEY_INVALID,
  );
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({
      trustedKeys: { key: keyEntry(), ' key ': keyEntry() },
    })),
    E.KEY_INVALID,
  );

  const symbolic = { key: keyEntry() };
  symbolic[Symbol('key')] = keyEntry();
  throwsCode(() => materializeExternalClientTrustConfig(profile({ trustedKeys: symbolic })), E.KEY_INVALID);

  const accessor = {};
  Object.defineProperty(accessor, 'key', {
    enumerable: true,
    get() { throw new Error('key getter'); },
  });
  throwsCode(() => materializeExternalClientTrustConfig(profile({ trustedKeys: accessor })), E.KEY_INVALID);

  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'key', { value: keyEntry(), enumerable: false });
  throwsCode(() => materializeExternalClientTrustConfig(profile({ trustedKeys: nonEnumerable })), E.KEY_INVALID);
});

test('key entry requires exact own enumerable fields without invoking accessors', () => {
  const unknown = keyEntry();
  unknown.extra = true;
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: { key: unknown } })),
    E.KEY_INVALID,
  );

  let calls = 0;
  const accessor = keyEntry();
  delete accessor.revoked;
  Object.defineProperty(accessor, 'revoked', {
    enumerable: true,
    get() { calls += 1; return false; },
  });
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: { key: accessor } })),
    E.KEY_INVALID,
  );
  assert.equal(calls, 0);

  const symbolic = keyEntry();
  symbolic[Symbol('entry')] = true;
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: { key: symbolic } })),
    E.KEY_INVALID,
  );

  const nonEnumerable = keyEntry();
  Object.defineProperty(nonEnumerable, 'revoked', { value: false, enumerable: false });
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: { key: nonEnumerable } })),
    E.KEY_INVALID,
  );
});

test('scope arrays must be exact singletons matching the profile root', () => {
  const cases = [
    { workspaceId: 'workspace-b' },
    { packageIds: [] },
    { packageIds: ['pkg.github.workspace-a', 'other'] },
    { packageIds: ['other'] },
    { identitySubjects: ['connector:other'] },
    { identityKinds: ['service'] },
  ];
  for (const patch of cases) {
    throwsCode(
      () => materializeExternalClientTrustConfig(profile({
        trustedKeys: { key: keyEntry(undefined, patch) },
      })),
      E.KEY_INVALID,
    );
  }

  const extended = ['pkg.github.workspace-a'];
  extended.extra = true;
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({
      trustedKeys: { key: keyEntry(undefined, { packageIds: extended }) },
    })),
    E.KEY_INVALID,
  );
});

test('only exact public Ed25519 SPKI DER bytes are accepted', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ format: 'der', type: 'spki' });
  const cases = [
    '-----BEGIN PUBLIC KEY-----',
    { kty: 'OKP' },
    Buffer.alloc(43),
    Buffer.alloc(44),
    privateDer,
    rsa,
  ];
  for (const publicKeySpkiDer of cases) {
    throwsCode(
      () => materializeExternalClientTrustConfig(profile({
        trustedKeys: { key: keyEntry(publicKeySpkiDer) },
      })),
      E.KEY_INVALID,
    );
  }
});

test('canonical validity interval and explicit non-revocation are required', () => {
  const cases = [
    { notBefore: '2026-08-02T11:00:00Z' },
    { notAfter: '2026-08-02T13:00:00Z' },
    { notAfter: '2026-08-02T11:00:00.000Z' },
    { notAfter: '2026-08-02T10:00:00.000Z' },
    { revoked: true },
    { revoked: 'false' },
  ];
  for (const patch of cases) {
    const code = patch.revoked === true ? E.KEY_REVOKED : E.KEY_INVALID;
    throwsCode(
      () => materializeExternalClientTrustConfig(profile({
        trustedKeys: { key: keyEntry(undefined, patch) },
      })),
      code,
    );
  }
  const missing = keyEntry();
  delete missing.revoked;
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: { key: missing } })),
    E.KEY_INVALID,
  );
});

test('rotation removal creates a new one-key snapshot without mutating the old snapshot', () => {
  const oldProfile = profile({ trustedKeys: { old: keyEntry(), next: keyEntry() } });
  const oldSnapshot = materializeExternalClientTrustConfig(oldProfile);
  const nextProfile = profile({ trustedKeys: { next: oldProfile.trustedKeys.next } });
  const nextSnapshot = materializeExternalClientTrustConfig(nextProfile);

  assert.deepEqual(Object.keys(oldSnapshot.trustedKeys), ['next', 'old']);
  assert.deepEqual(Object.keys(nextSnapshot.trustedKeys), ['next']);
  assert.deepEqual(Object.keys(oldSnapshot.trustedKeys), ['next', 'old']);
});

test('hostile proxies use bounded configuration errors rather than raw traps', () => {
  const rootProxy = new Proxy(profile(), {
    ownKeys() { throw new Error('root trap'); },
  });
  throwsCode(() => materializeExternalClientTrustConfig(rootProxy), E.AUTHORITY_REQUIRED);

  const rosterProxy = new Proxy({ key: keyEntry() }, {
    ownKeys() { throw new Error('roster trap'); },
  });
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: rosterProxy })),
    E.KEY_INVALID,
  );

  const entryProxy = new Proxy(keyEntry(), {
    getPrototypeOf() { throw new Error('entry trap'); },
  });
  throwsCode(
    () => materializeExternalClientTrustConfig(profile({ trustedKeys: { key: entryProxy } })),
    E.KEY_INVALID,
  );
});

test('materializer source has no environment, filesystem, network, clock or runtime side effects', () => {
  const source = fs.readFileSync(path.join(__dirname, 'external-client-trust-config.js'), 'utf8');
  assert.doesNotMatch(source, /process\.env|require\(['"](?:node:)?fs['"]\)|require\(['"](?:node:)?https?['"]\)|Date\.now\s*\(|new\s+Date\s*\(\s*\)|globalThis|server\.js|snapshotExternalClientAuthority|replayStore|receipt|mutation|WeakSet|WeakMap/i);
  assert.match(source, /require\(['"]node:crypto['"]\)/);
});
