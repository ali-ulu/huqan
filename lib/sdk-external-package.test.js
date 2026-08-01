'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { stableStringify } = require('./receipt/canonical-receipt');
const { EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS } = require('./external-client-package-gate');
const {
  EXTERNAL_CLIENT_PACKAGE_SDK_ERRORS,
  createAxiomClient,
} = require('./sdk');

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

function makePackage() {
  const objectCounts = {};
  const objects = {};
  for (const name of OBJECT_COLLECTIONS) {
    objectCounts[name] = 0;
    objects[name] = [];
  }
  return {
    manifest: {
      packageId: 'pkg.github.workspace-a',
      format: 'axiom-package',
      formatVersion: '0.1',
      createdAt: '2026-08-01T18:30:00.000Z',
      createdBy: 'connector:github',
      workspaceId: 'workspace-a',
      description: 'SDK package admission fixture',
      atpVersion: '0.1',
      objectCounts,
    },
    objects,
    index: { byId: {}, bySourceRef: {}, byWorkspaceId: {}, byType: {} },
    metadata: { warnings: [] },
  };
}

function signPackage(pkg, privateKey) {
  return {
    algorithm: 'ed25519',
    keyId: 'trusted-key-1',
    value: crypto.sign(null, Buffer.from(stableStringify(pkg), 'utf8'), privateKey).toString('base64'),
  };
}

function makeInput(pkg, privateKey) {
  return {
    identity: { subject: 'connector:github', kind: 'connector' },
    workspaceId: 'workspace-a',
    package: pkg,
    signature: signPackage(pkg, privateKey),
  };
}

function makeOptions(publicKey, packageAdmissionHandler) {
  return {
    expectedWorkspaceId: 'workspace-a',
    expectedPackageId: 'pkg.github.workspace-a',
    trustedKeys: {
      'trusted-key-1': {
        publicKey,
        workspaceId: 'workspace-a',
        packageIds: ['pkg.github.workspace-a'],
        identitySubjects: ['connector:github'],
        identityKinds: ['connector'],
      },
    },
    packageAdmissionHandler,
  };
}

test('SDK gates before admission and passes immutable verified context', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  let calls = 0;
  const client = createAxiomClient({}, makeOptions(publicKey, async (snapshot, context) => {
    calls += 1;
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.manifest), true);
    assert.equal(Object.isFrozen(context), true);
    assert.equal(context.identity.subject, 'connector:github');
    assert.equal(context.workspaceId, 'workspace-a');
    assert.equal(context.packageId, 'pkg.github.workspace-a');
    assert.match(context.packageHash, /^[a-f0-9]{64}$/);
    return { admitted: true, packageHash: context.packageHash };
  }));

  const result = await client.admitExternalPackage(makeInput(pkg, privateKey));
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.gate.decision, 'allow');
  assert.deepEqual(result.admission, { admitted: true, packageHash: result.gate.packageHash });
});

test('invalid signature fails before the admission handler', async () => {
  const trusted = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  let calls = 0;
  const client = createAxiomClient({}, makeOptions(trusted.publicKey, () => { calls += 1; }));

  await assert.rejects(
    client.admitExternalPackage(makeInput(pkg, attacker.privateKey)),
    (error) => error.code === EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_INVALID,
  );
  assert.equal(calls, 0);
});

test('authority and handler are snapshotted at client creation', async () => {
  const trusted = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  let trustedCalls = 0;
  let attackerCalls = 0;
  const options = makeOptions(trusted.publicKey, () => {
    trustedCalls += 1;
    return { admitted: true };
  });
  const client = createAxiomClient({}, options);

  options.expectedWorkspaceId = 'workspace-b';
  options.expectedPackageId = 'pkg.attacker';
  options.trustedKeys['trusted-key-1'].publicKey = attacker.publicKey;
  options.packageAdmissionHandler = () => { attackerCalls += 1; };

  const result = await client.admitExternalPackage(makeInput(pkg, trusted.privateKey));
  assert.equal(result.ok, true);
  assert.equal(trustedCalls, 1);
  assert.equal(attackerCalls, 0);
});

test('mutable trusted-key descriptors cannot replace snapshotted key material', async () => {
  const trusted = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  let calls = 0;
  const publicKey = {
    key: trusted.publicKey.export({ format: 'der', type: 'spki' }),
    format: 'der',
    type: 'spki',
  };
  const client = createAxiomClient({}, makeOptions(publicKey, () => { calls += 1; }));

  attacker.publicKey.export({ format: 'der', type: 'spki' }).copy(publicKey.key);

  await assert.rejects(
    client.admitExternalPackage(makeInput(pkg, attacker.privateKey)),
    (error) => error.code === EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_INVALID,
  );
  assert.equal(calls, 0);
});

test('normalized trusted-key ID collisions fail closed before admission', () => {
  const trusted = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  let calls = 0;
  const options = makeOptions(trusted.publicKey, () => { calls += 1; });
  options.trustedKeys[' trusted-key-1 '] = {
    ...options.trustedKeys['trusted-key-1'],
    publicKey: attacker.publicKey,
  };

  assert.throws(
    () => createAxiomClient({}, options),
    (error) => error.code === EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_REQUIRED,
  );
  assert.equal(calls, 0);
});

test('private key material is rejected from trusted public-key authority', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  let calls = 0;
  const privateInputs = [
    privateKey.export({ format: 'pem', type: 'pkcs8' }),
    {
      key: privateKey.export({ format: 'der', type: 'pkcs8' }),
      format: 'der',
      type: 'pkcs8',
    },
  ];

  for (const publicKey of privateInputs) {
    assert.throws(
      () => createAxiomClient({}, makeOptions(publicKey, () => { calls += 1; })),
      (error) => error.code === EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_REQUIRED,
    );
  }
  assert.equal(calls, 0);
});

test('handler receives verified snapshot, not caller-mutable package', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let observed;
  const client = createAxiomClient({}, makeOptions(publicKey, async (snapshot) => {
    observed = snapshot;
    await wait;
    return { description: snapshot.manifest.description };
  }));

  const pending = client.admitExternalPackage(makeInput(pkg, privateKey));
  pkg.manifest.description = 'mutated';
  release();
  const result = await pending;

  assert.notEqual(observed, pkg);
  assert.equal(observed.manifest.description, 'SDK package admission fixture');
  assert.equal(result.admission.description, 'SDK package admission fixture');
});

test('valid package fails closed without admission handler', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  const options = makeOptions(publicKey, null);
  delete options.packageAdmissionHandler;
  const client = createAxiomClient({}, options);

  await assert.rejects(
    client.admitExternalPackage(makeInput(pkg, privateKey)),
    (error) => error.code === EXTERNAL_CLIENT_PACKAGE_SDK_ERRORS.HANDLER_REQUIRED,
  );
});
