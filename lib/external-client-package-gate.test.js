'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { stableStringify } = require('./receipt/canonical-receipt');
const { createHuqanPackage } = require('./axiom-package-format');
const {
  EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS,
  EXTERNAL_CLIENT_PACKAGE_GATE_VERSION,
  enforceExternalClientPackage,
} = require('./external-client-package-gate');

const OBJECT_COLLECTIONS = Object.freeze([
  'provenanceRecords',
  'auditEvents',
  'candidateClaims',
  'conflictResults',
  'verificationResults',
  'trustReceipts',
  'causalChains',
  'simulationResults',
]);

function makePackage(overrides = {}) {
  const objectCounts = {};
  const objects = {};
  for (const name of OBJECT_COLLECTIONS) {
    objectCounts[name] = 0;
    objects[name] = [];
  }

  const pkg = {
    manifest: {
      packageId: 'pkg.github.workspace-a',
      format: 'axiom-package',
      formatVersion: '0.1',
      createdAt: '2026-08-01T18:30:00.000Z',
      createdBy: 'connector:github',
      workspaceId: 'workspace-a',
      source: { type: 'test', sourceRef: 'huqan://test/package' },
      description: 'Signed external client package fixture',
      atpVersion: '0.1',
      objectCounts,
    },
    objects,
    index: {
      byId: {},
      bySourceRef: {},
      byWorkspaceId: {},
      byType: {},
    },
    metadata: {
      warnings: [],
    },
  };

  if (overrides.manifest) Object.assign(pkg.manifest, overrides.manifest);
  if (overrides.index) Object.assign(pkg.index, overrides.index);
  if (overrides.metadata) Object.assign(pkg.metadata, overrides.metadata);
  if (overrides.objects) Object.assign(pkg.objects, overrides.objects);
  for (const [key, value] of Object.entries(overrides)) {
    if (!['manifest', 'index', 'metadata', 'objects'].includes(key)) pkg[key] = value;
  }
  return pkg;
}

function makeKeys() {
  return crypto.generateKeyPairSync('ed25519');
}

function signPackage(pkg, privateKey, overrides = {}) {
  return {
    algorithm: 'ed25519',
    keyId: 'trusted-key-1',
    value: crypto.sign(
      null,
      Buffer.from(stableStringify(pkg), 'utf8'),
      privateKey,
    ).toString('base64'),
    ...overrides,
  };
}

function makeInput(pkg, privateKey, overrides = {}) {
  return {
    identity: {
      subject: 'connector:github',
      kind: 'connector',
    },
    workspaceId: 'workspace-a',
    package: pkg,
    signature: signPackage(pkg, privateKey),
    ...overrides,
  };
}

function trustedEntry(publicKey, overrides = {}) {
  return {
    publicKey,
    workspaceId: 'workspace-a',
    packageIds: ['pkg.github.workspace-a'],
    identitySubjects: ['connector:github'],
    identityKinds: ['connector'],
    ...overrides,
  };
}

function gateOptions(publicKey, overrides = {}) {
  return {
    expectedWorkspaceId: 'workspace-a',
    expectedPackageId: 'pkg.github.workspace-a',
    trustedKeys: {
      'trusted-key-1': trustedEntry(publicKey),
    },
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('allows an exact signed package and exposes identity and scope in the receipt', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();

  const result = enforceExternalClientPackage(
    makeInput(pkg, privateKey),
    gateOptions(publicKey),
  );

  assert.equal(result.ok, true);
  assert.equal(result.decision, 'allow');
  assert.equal(result.gateVersion, EXTERNAL_CLIENT_PACKAGE_GATE_VERSION);
  assert.equal(result.identity.subject, 'connector:github');
  assert.equal(result.identity.kind, 'connector');
  assert.equal(result.workspaceId, 'workspace-a');
  assert.equal(result.packageId, 'pkg.github.workspace-a');
  assert.equal(result.packageFormat, 'axiom-package');
  assert.equal(result.packageFormatVersion, '0.1');
  assert.equal(result.packageProtocolVersion, '0.1');
  assert.equal(result.atpVersion, '0.1');
  assert.match(result.packageHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.signature, {
    algorithm: 'ed25519',
    keyId: 'trusted-key-1',
    verified: true,
  });
  assert.deepEqual(result.receipt, {
    gateVersion: EXTERNAL_CLIENT_PACKAGE_GATE_VERSION,
    decision: 'allow',
    identitySubject: 'connector:github',
    identityKind: 'connector',
    workspaceId: 'workspace-a',
    packageId: 'pkg.github.workspace-a',
    packageFormat: 'axiom-package',
    packageFormatVersion: '0.1',
    packageProtocolVersion: '0.1',
    atpVersion: '0.1',
    packageHash: result.packageHash,
    signatureAlgorithm: 'ed25519',
    trustedKeyId: 'trusted-key-1',
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.identity), true);
  assert.equal(Object.isFrozen(result.signature), true);
  assert.equal(Object.isFrozen(result.receipt), true);
});

test('allows a canonical signed HUQAN package with neutral protocol evidence', () => {
  const pkg = createHuqanPackage(makePackage());
  const { publicKey, privateKey } = makeKeys();
  const result = enforceExternalClientPackage(
    makeInput(pkg, privateKey),
    gateOptions(publicKey),
  );

  assert.equal(result.packageFormat, 'huqan-package');
  assert.equal(result.packageFormatVersion, '0.2');
  assert.equal(result.packageProtocolVersion, '0.1');
  assert.equal(result.atpVersion, null);
  assert.equal(result.receipt.atpVersion, null);
});

test('missing client identity fails closed', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();
  const input = makeInput(pkg, privateKey);
  delete input.identity;

  expectCode(
    () => enforceExternalClientPackage(input, gateOptions(publicKey)),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.MISSING_IDENTITY,
  );
});

test('missing client workspace fails closed instead of defaulting', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();
  const input = makeInput(pkg, privateKey);
  delete input.workspaceId;

  expectCode(
    () => enforceExternalClientPackage(input, gateOptions(publicKey)),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.MISSING_WORKSPACE,
  );
});

test('missing authoritative workspace fails closed', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();
  const options = gateOptions(publicKey);
  delete options.expectedWorkspaceId;

  expectCode(
    () => enforceExternalClientPackage(makeInput(pkg, privateKey), options),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.AUTHORITATIVE_WORKSPACE_REQUIRED,
  );
});

test('authoritative workspace mismatch fails closed before package use', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();

  expectCode(
    () => enforceExternalClientPackage(
      makeInput(pkg, privateKey),
      gateOptions(publicKey, { expectedWorkspaceId: 'workspace-b' }),
    ),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.WORKSPACE_MISMATCH,
  );
});

test('invalid AXIOM package fails closed with validator evidence', () => {
  const pkg = makePackage();
  delete pkg.manifest.atpVersion;
  const { publicKey, privateKey } = makeKeys();

  assert.throws(
    () => enforceExternalClientPackage(makeInput(pkg, privateKey), gateOptions(publicKey)),
    (error) => {
      assert.equal(error.code, EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.INVALID_PACKAGE);
      assert.ok(Array.isArray(error.details.errors));
      assert.ok(error.details.errors.some((entry) => entry.field === 'manifest.atpVersion'));
      return true;
    },
  );
});

test('package validator warnings are rejected instead of silently accepted', () => {
  const pkg = makePackage();
  pkg.manifest.objectCounts.auditEvents = 1;
  const { publicKey, privateKey } = makeKeys();

  assert.throws(
    () => enforceExternalClientPackage(makeInput(pkg, privateKey), gateOptions(publicKey)),
    (error) => {
      assert.equal(error.code, EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.INVALID_PACKAGE);
      assert.ok(error.details.warnings.some((entry) => /expected 1 but found 0/.test(entry.message)));
      return true;
    },
  );
});

test('missing authoritative package identity fails closed', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();
  const options = gateOptions(publicKey);
  delete options.expectedPackageId;

  expectCode(
    () => enforceExternalClientPackage(makeInput(pkg, privateKey), options),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.EXPECTED_PACKAGE_REQUIRED,
  );
});

test('expected package identity mismatch fails closed', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();

  expectCode(
    () => enforceExternalClientPackage(
      makeInput(pkg, privateKey),
      gateOptions(publicKey, { expectedPackageId: 'pkg.other' }),
    ),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.PACKAGE_ID_MISMATCH,
  );
});

test('package workspace mismatch fails closed', () => {
  const pkg = makePackage({ manifest: { workspaceId: 'workspace-b' } });
  const { publicKey, privateKey } = makeKeys();

  expectCode(
    () => enforceExternalClientPackage(makeInput(pkg, privateKey), gateOptions(publicKey)),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.PACKAGE_WORKSPACE_MISMATCH,
  );
});

test('package createdBy must match the authenticated client identity', () => {
  const pkg = makePackage({ manifest: { createdBy: 'connector:other' } });
  const { publicKey, privateKey } = makeKeys();

  expectCode(
    () => enforceExternalClientPackage(makeInput(pkg, privateKey), gateOptions(publicKey)),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.PACKAGE_IDENTITY_MISMATCH,
  );
});

test('untrusted signing key fails closed', () => {
  const pkg = makePackage();
  const { privateKey } = makeKeys();

  expectCode(
    () => enforceExternalClientPackage(makeInput(pkg, privateKey), {
      expectedWorkspaceId: 'workspace-a',
      expectedPackageId: 'pkg.github.workspace-a',
      trustedKeys: {},
    }),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_REQUIRED,
  );
});

test('trusted key scope must authorize identity kind, subject, workspace and package', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();
  const options = gateOptions(publicKey);
  options.trustedKeys['trusted-key-1'] = trustedEntry(publicKey, {
    identityKinds: ['service'],
  });

  expectCode(
    () => enforceExternalClientPackage(makeInput(pkg, privateKey), options),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_SCOPE_MISMATCH,
  );
});

test('unsupported signature algorithms fail closed', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();
  const input = makeInput(pkg, privateKey);
  input.signature.algorithm = 'rsa-sha256';

  expectCode(
    () => enforceExternalClientPackage(input, gateOptions(publicKey)),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_ALGORITHM_UNSUPPORTED,
  );
});

test('tampered package content invalidates the otherwise trusted signature', () => {
  const pkg = makePackage();
  const { publicKey, privateKey } = makeKeys();
  const input = makeInput(pkg, privateKey);
  input.package.manifest.description = 'tampered after signing';

  expectCode(
    () => enforceExternalClientPackage(input, gateOptions(publicKey)),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_INVALID,
  );
});

test('signature from a different private key fails closed', () => {
  const pkg = makePackage();
  const trusted = makeKeys();
  const attacker = makeKeys();

  expectCode(
    () => enforceExternalClientPackage(
      makeInput(pkg, attacker.privateKey),
      gateOptions(trusted.publicKey),
    ),
    EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_INVALID,
  );
});
