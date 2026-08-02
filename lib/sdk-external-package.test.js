'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { stableStringify } = require('./receipt/canonical-receipt');
const { EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS } = require('./external-client-package-gate');
const {
  EXTERNAL_CLIENT_AUTHORITY_ERRORS,
  EXTERNAL_CLIENT_ADMISSION_PERMISSION,
} = require('./external-client-authority');
const {
  EXTERNAL_CLIENT_PACKAGE_SDK_ERRORS,
  createAxiomClient,
} = require('./sdk');

const NOW = Date.parse('2026-08-02T12:00:00.000Z');
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
      createdAt: '2026-08-02T11:59:00.000Z',
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
  if (overrides.manifest) Object.assign(pkg.manifest, overrides.manifest);
  return pkg;
}

function signPackage(pkg, privateKey) {
  return {
    algorithm: 'ed25519',
    keyId: 'trusted-key-1',
    value: crypto.sign(null, Buffer.from(stableStringify(pkg), 'utf8'), privateKey).toString('base64'),
  };
}

function makeInput(pkg, privateKey, overrides = {}) {
  return {
    identity: { subject: 'connector:github', kind: 'connector' },
    workspaceId: 'workspace-a',
    package: pkg,
    signature: signPackage(pkg, privateKey),
    ...overrides,
  };
}

function makeReplayStore(events = null) {
  const seen = new Set();
  const calls = [];
  return {
    calls,
    reserve(record) {
      calls.push(record);
      if (events) events.push('reserve');
      if (seen.has(record.replayKey)) return { reserved: false, existing: true };
      seen.add(record.replayKey);
      return { reserved: true };
    },
  };
}

function makeOptions(publicKey, packageAdmissionHandler, overrides = {}) {
  const options = {
    expectedIdentitySubject: 'connector:github',
    expectedIdentityKind: 'connector',
    expectedWorkspaceId: 'workspace-a',
    expectedPackageId: 'pkg.github.workspace-a',
    permissions: [EXTERNAL_CLIENT_ADMISSION_PERMISSION],
    trustedKeys: {
      'trusted-key-1': {
        publicKey,
        workspaceId: 'workspace-a',
        packageIds: ['pkg.github.workspace-a'],
        identitySubjects: ['connector:github'],
        identityKinds: ['connector'],
        notBefore: '2026-08-02T11:00:00.000Z',
        notAfter: '2026-08-02T13:00:00.000Z',
        revoked: false,
      },
    },
    clock: () => NOW,
    replayStore: makeReplayStore(),
  };
  if (typeof packageAdmissionHandler === 'function') {
    options.packageAdmissionHandler = packageAdmissionHandler;
  }
  return Object.assign(options, overrides);
}

test('SDK gates and reserves before admission and passes immutable verified authority context', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  const events = [];
  const replayStore = makeReplayStore(events);
  let calls = 0;
  const client = createAxiomClient({}, makeOptions(publicKey, async (snapshot, context) => {
    events.push('handler');
    calls += 1;
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.manifest), true);
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.authority), true);
    assert.equal(context.identity.subject, 'connector:github');
    assert.equal(context.workspaceId, 'workspace-a');
    assert.equal(context.packageId, 'pkg.github.workspace-a');
    assert.equal(context.permission, EXTERNAL_CLIENT_ADMISSION_PERMISSION);
    assert.match(context.packageHash, /^[a-f0-9]{64}$/);
    assert.match(context.replayKey, /^external-client-authority-0-v1:[a-f0-9]{64}$/);
    return { admitted: true, packageHash: context.packageHash };
  }, { replayStore }));

  const result = await client.admitExternalPackage(makeInput(pkg, privateKey));
  assert.deepEqual(events, ['reserve', 'handler']);
  assert.equal(calls, 1);
  assert.equal(replayStore.calls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.gate.decision, 'allow');
  assert.equal(result.authority.decision, 'allow');
  assert.deepEqual(result.admission, { admitted: true, packageHash: result.gate.packageHash });
  assert.equal(Object.isFrozen(result), true);
});

test('invalid signature fails before clock, replay owner or admission handler side effects', async () => {
  const trusted = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  let clockCalls = 0;
  let handlerCalls = 0;
  const replayStore = makeReplayStore();
  const options = makeOptions(trusted.publicKey, () => { handlerCalls += 1; }, {
    replayStore,
    clock: () => { clockCalls += 1; return NOW; },
  });
  const client = createAxiomClient({}, options);

  await assert.rejects(
    client.admitExternalPackage(makeInput(pkg, attacker.privateKey)),
    (error) => error.code === EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_INVALID,
  );
  assert.equal(clockCalls, 0);
  assert.equal(replayStore.calls.length, 0);
  assert.equal(handlerCalls, 0);
});

test('authority, handler, clock and replay owner are snapshotted at client creation', async () => {
  const trusted = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  let trustedCalls = 0;
  let attackerCalls = 0;
  const replayStore = makeReplayStore();
  const options = makeOptions(trusted.publicKey, () => {
    trustedCalls += 1;
    return { admitted: true };
  }, { replayStore });
  const client = createAxiomClient({}, options);

  options.expectedIdentitySubject = 'connector:attacker';
  options.expectedWorkspaceId = 'workspace-b';
  options.expectedPackageId = 'pkg.attacker';
  options.permissions[0] = 'package:read';
  options.clock = () => Number.NaN;
  options.trustedKeys['trusted-key-1'].publicKey = attacker.publicKey;
  options.trustedKeys['trusted-key-1'].revoked = true;
  options.replayStore.reserve = () => ({ reserved: false });
  options.packageAdmissionHandler = () => { attackerCalls += 1; };

  const result = await client.admitExternalPackage(makeInput(pkg, trusted.privateKey));
  assert.equal(result.ok, true);
  assert.equal(trustedCalls, 1);
  assert.equal(attackerCalls, 0);
  assert.equal(replayStore.calls.length, 1);
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
    (error) => error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
  );
  assert.equal(calls, 0);
});

test('private key material is rejected from trusted public-key authority', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  let calls = 0;
  const privateInputs = [
    privateKey,
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
      (error) => error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
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
  const client = createAxiomClient({}, makeOptions(publicKey, async (snapshot, context) => {
    observed = snapshot;
    assert.equal(Object.isFrozen(context.authorityReceipt), true);
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

test('valid package reserves first and then fails closed without an admission handler', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  const replayStore = makeReplayStore();
  const client = createAxiomClient({}, makeOptions(publicKey, null, { replayStore }));

  await assert.rejects(
    client.admitExternalPackage(makeInput(pkg, privateKey)),
    (error) => error.code === EXTERNAL_CLIENT_PACKAGE_SDK_ERRORS.HANDLER_REQUIRED,
  );
  assert.equal(replayStore.calls.length, 1);
});

test('second admission of the same signed package is rejected before the handler', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  let handlerCalls = 0;
  const replayStore = makeReplayStore();
  const client = createAxiomClient({}, makeOptions(publicKey, () => {
    handlerCalls += 1;
    return { admitted: true };
  }, { replayStore }));
  const input = makeInput(pkg, privateKey);

  await client.admitExternalPackage(input);
  await assert.rejects(
    client.admitExternalPackage(input),
    (error) => error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_DETECTED,
  );
  assert.equal(handlerCalls, 1);
  assert.equal(replayStore.calls.length, 2);
});

test('handler failure after reservation does not release or silently retry the replay key', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pkg = makePackage();
  const replayStore = makeReplayStore();
  let handlerCalls = 0;
  const client = createAxiomClient({}, makeOptions(publicKey, () => {
    handlerCalls += 1;
    throw new Error('handler failed');
  }, { replayStore }));
  const input = makeInput(pkg, privateKey);

  await assert.rejects(client.admitExternalPackage(input), /handler failed/);
  await assert.rejects(
    client.admitExternalPackage(input),
    (error) => error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_DETECTED,
  );
  assert.equal(handlerCalls, 1);
  assert.equal(replayStore.calls.length, 2);
  assert.equal(replayStore.calls[0].replayKey, replayStore.calls[1].replayKey);
});

test('SDK remains usable without package authority until external package admission is invoked', async () => {
  const kernel = {
    verify(statement) { return { statement }; },
    reason(subject) { return { subject }; },
  };
  const client = createAxiomClient(kernel);

  assert.deepEqual(client.verify('claim'), { statement: 'claim' });
  assert.deepEqual(client.reason('topic'), { subject: 'topic' });
  await assert.rejects(
    client.admitExternalPackage({ package: {} }),
    (error) => error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
  );
});
