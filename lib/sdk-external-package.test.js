'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { stableStringify } = require('./receipt/canonical-receipt');
const { EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS } = require('./external-client-package-gate');
const {
  EXTERNAL_CLIENT_AUTHORITY_ERRORS,
  EXTERNAL_CLIENT_ADMISSION_PERMISSION,
  EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS,
  EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS,
} = require('./external-client-authority');
const {
  EXTERNAL_CLIENT_PACKAGE_SDK_ERRORS,
  createAxiomClient,
} = require('./sdk');
const {
  EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV,
  buildExternalClientEndpointContract,
} = require('./external-client-endpoint-contract');

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

test('SDK rejection matrix leaves replay, admission and Kernel fallback untouched', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const cases = [
    ['malformed package', EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.INVALID_PACKAGE,
      () => makeInput({}, privateKey)],
    ['tampered package', EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_INVALID, () => {
      const pkg = makePackage();
      const signed = makeInput(pkg, privateKey);
      pkg.manifest.description = 'tampered after signing';
      return signed;
    }],
    ['identity subject mismatch', EXTERNAL_CLIENT_AUTHORITY_ERRORS.IDENTITY_MISMATCH,
      () => makeInput(makePackage(), privateKey), (options) => { options.expectedIdentitySubject = 'connector:other'; }],
    ['identity kind mismatch', EXTERNAL_CLIENT_AUTHORITY_ERRORS.IDENTITY_MISMATCH,
      () => makeInput(makePackage(), privateKey), (options) => { options.expectedIdentityKind = 'service'; }],
    ['workspace mismatch', EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.WORKSPACE_MISMATCH,
      () => makeInput(makePackage(), privateKey, { workspaceId: 'workspace-b' })],
    ['package mismatch', EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.PACKAGE_ID_MISMATCH,
      () => makeInput(makePackage(), privateKey), (options) => { options.expectedPackageId = 'pkg.other'; }],
    ['trusted-key scope mismatch', EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_SCOPE_MISMATCH,
      () => makeInput(makePackage(), privateKey), (options) => { options.trustedKeys['trusted-key-1'].packageIds = ['pkg.other']; }],
    ['revoked key', EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_REVOKED,
      () => makeInput(makePackage(), privateKey), (options) => { options.trustedKeys['trusted-key-1'].revoked = true; }, true],
    ['not-yet-valid key', EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
      () => makeInput(makePackage(), privateKey), (options) => { options.trustedKeys['trusted-key-1'].notBefore = '2026-08-02T12:00:00.001Z'; }],
    ['expired key', EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
      () => makeInput(makePackage(), privateKey), (options) => { options.trustedKeys['trusted-key-1'].notAfter = '2026-08-02T11:59:59.999Z'; }],
    ['invalid createdAt', EXTERNAL_CLIENT_AUTHORITY_ERRORS.CREATED_AT_INVALID,
      () => makeInput(makePackage({ manifest: { createdAt: '2026-08-02T11:59:00Z' } }), privateKey)],
    ['stale createdAt', EXTERNAL_CLIENT_AUTHORITY_ERRORS.STALE,
      () => makeInput(makePackage({ manifest: { createdAt: new Date(NOW - EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS - 1).toISOString() } }), privateKey)],
    ['future createdAt', EXTERNAL_CLIENT_AUTHORITY_ERRORS.FUTURE_DATED,
      () => makeInput(makePackage({ manifest: { createdAt: new Date(NOW + EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS + 1).toISOString() } }), privateKey)],
  ];

  for (const [, code, makeRejectedInput, configure, snapshotFailure] of cases) {
    for (const useKernelFallback of [false, true]) {
      const replayStore = makeReplayStore();
      let handlerCalls = 0;
      let kernelFallbackCalls = 0;
      const kernel = { admitExternalPackage() { kernelFallbackCalls += 1; } };
      const authorityOptions = makeOptions(publicKey, useKernelFallback ? null : () => { handlerCalls += 1; }, {
        replayStore,
      });
      if (configure) configure(authorityOptions);

      if (snapshotFailure) {
        assert.throws(() => createAxiomClient(kernel, authorityOptions), (error) => error.code === code);
      } else {
        const client = createAxiomClient(kernel, authorityOptions);
        await assert.rejects(client.admitExternalPackage(makeRejectedInput()), (error) => error.code === code);
      }
      assert.equal(replayStore.calls.length, 0);
      assert.equal(handlerCalls, 0);
      assert.equal(kernelFallbackCalls, 0);
    }
  }
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

test('replay reservation failures never reach the SDK admission handler', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const cases = [
    () => { throw new Error('reserve throw'); },
    async () => { throw new Error('reserve reject'); },
    () => ({ reserved: true, extra: true }),
  ];
  for (const reserve of cases) {
    for (const useKernelFallback of [false, true]) {
      let reserveCalls = 0;
      let handlerCalls = 0;
      let kernelFallbackCalls = 0;
      const kernel = { admitExternalPackage() { kernelFallbackCalls += 1; } };
      const client = createAxiomClient(kernel, makeOptions(
        publicKey,
        useKernelFallback ? null : () => { handlerCalls += 1; },
        { replayStore: { reserve(record) { reserveCalls += 1; return reserve(record); } } },
      ));
      await assert.rejects(
        client.admitExternalPackage(makeInput(makePackage(), privateKey)),
        (error) => error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_RESERVATION_FAILED,
      );
      assert.equal(reserveCalls, 1);
      assert.equal(handlerCalls, 0);
      assert.equal(kernelFallbackCalls, 0);
    }
  }
});

test('permission and revocation failures occur while SDK authority is snapshotted', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  for (const [mutate, code] of [
    [(options) => { delete options.permissions; }, EXTERNAL_CLIENT_AUTHORITY_ERRORS.PERMISSION_REQUIRED],
    [(options) => { options.permissions = []; }, EXTERNAL_CLIENT_AUTHORITY_ERRORS.PERMISSION_REQUIRED],
    [(options) => { options.trustedKeys['trusted-key-1'].revoked = true; }, EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_REVOKED],
  ]) {
    let handlerCalls = 0;
    let kernelFallbackCalls = 0;
    const replayStore = makeReplayStore();
    const authorityOptions = makeOptions(publicKey, () => { handlerCalls += 1; }, { replayStore });
    mutate(authorityOptions);
    const kernel = { admitExternalPackage() { kernelFallbackCalls += 1; } };
    assert.throws(
      () => createAxiomClient(kernel, authorityOptions),
      (error) => error.code === code,
    );
    assert.equal(replayStore.calls.length, 0);
    assert.equal(handlerCalls, 0);
    assert.equal(kernelFallbackCalls, 0);
  }
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

test('concurrent identical admissions allow once and reject the replay before a second handler call', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const replayStore = makeReplayStore();
  let handlerCalls = 0;
  const client = createAxiomClient({}, makeOptions(publicKey, async () => {
    handlerCalls += 1;
    return { admitted: true };
  }, { replayStore }));
  const signed = makeInput(makePackage(), privateKey);
  const results = await Promise.allSettled([
    client.admitExternalPackage(signed),
    client.admitExternalPackage(signed),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = results.find((result) => result.status === 'rejected');
  assert.equal(rejection.reason.code, EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_DETECTED);
  assert.equal(handlerCalls, 1);
  assert.equal(replayStore.calls.length, 2);
  assert.equal(replayStore.calls[0].replayKey, replayStore.calls[1].replayKey);
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

test('Endpoint requested configuration does not create SDK package authority', async () => {
  const endpoint = buildExternalClientEndpointContract({
    [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: 'true',
  });
  let kernelFallbackCalls = 0;
  const client = createAxiomClient({
    admitExternalPackage() { kernelFallbackCalls += 1; },
  }, endpoint);

  assert.equal(endpoint.configurationState, 'requested');
  await assert.rejects(
    client.admitExternalPackage({ package: {} }),
    (error) => error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
  );
  assert.equal(kernelFallbackCalls, 0);
});

test('createAxiomClient stays constructible for non-package use when the Kernel exposes admitExternalPackage but no Authority-0 options exist', async () => {
  let admitCalls = 0;
  const kernel = {
    verify(statement) { return { statement }; },
    reason(subject) { return { subject }; },
    admitExternalPackage() { admitCalls += 1; return { admitted: true }; },
  };

  const client = createAxiomClient(kernel);

  assert.deepEqual(client.verify('claim'), { statement: 'claim' });
  assert.deepEqual(client.reason('topic'), { subject: 'topic' });
  await assert.rejects(
    client.admitExternalPackage({ package: {} }),
    (error) => error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
  );
  assert.equal(admitCalls, 0);
});

test('package admission fails closed even when explicit options omit required Authority-0 fields', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const kernel = { admitExternalPackage() { return { admitted: true }; } };
  const incompleteOptions = makeOptions(publicKey, null);
  delete incompleteOptions.clock;

  assert.throws(
    () => createAxiomClient(kernel, incompleteOptions),
    (error) => error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.CLOCK_INVALID,
  );
});
