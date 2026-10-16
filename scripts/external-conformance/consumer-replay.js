'use strict';

const crypto = require('node:crypto');
const { record, checkAsync, assert } = require('./consumer-harness');
const { packageFormat } = require('./consumer-package-wire');

// External conformance cases: installed-package replay rejection (async). Runs
// on require, in the order consumer.js requires the sections.

function replayPackage(createdAt) {
  const collections = ['provenanceRecords', 'auditEvents', 'candidateClaims', 'conflictResults',
    'verificationResults', 'trustReceipts', 'causalChains', 'simulationResults'];
  const objectCounts = {}; const objects = {};
  for (const name of collections) { objectCounts[name] = 0; objects[name] = []; }
  const legacy = {
    manifest: {
      packageId: 'pkg.external.conformance', format: 'axiom-package', formatVersion: '0.1',
      createdAt, createdBy: 'connector:external-conformance', workspaceId: 'workspace-conformance',
      source: { type: 'test', sourceRef: 'huqan://external-conformance/replay' },
      description: 'Installed-package replay fixture', atpVersion: '0.1', objectCounts,
    },
    objects,
    index: { byId: {}, bySourceRef: {}, byWorkspaceId: {}, byType: {} },
    metadata: { warnings: [] },
  };
  return packageFormat.createHuqanPackage(legacy);
}

checkAsync('replay', 'installed authority accepts once and rejects the identical signed package replay', async () => {
  const { stableStringify } = require('huqan/lib/receipt/canonical-receipt');
  const {
    EXTERNAL_CLIENT_ADMISSION_PERMISSION,
    EXTERNAL_CLIENT_AUTHORITY_ERRORS,
    enforceExternalClientAuthority,
    snapshotExternalClientAuthority,
  } = require('huqan/lib/external-client-authority');
  const now = Date.parse('2026-08-02T12:00:00.000Z');
  const createdAt = '2026-08-02T11:59:00.000Z';
  const pkg = replayPackage(createdAt);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signature = {
    algorithm: 'ed25519',
    keyId: 'external-conformance-key',
    value: crypto.sign(null, Buffer.from(stableStringify(pkg), 'utf8'), privateKey).toString('base64'),
  };
  const seen = new Set();
  const replayStore = {
    reserve(record) {
      if (seen.has(record.replayKey)) return { reserved: false, existing: { replayKey: record.replayKey } };
      seen.add(record.replayKey);
      return { reserved: true };
    },
  };
  const authority = snapshotExternalClientAuthority({
    expectedIdentitySubject: 'connector:external-conformance',
    expectedIdentityKind: 'connector',
    expectedWorkspaceId: 'workspace-conformance',
    expectedPackageId: 'pkg.external.conformance',
    permissions: [EXTERNAL_CLIENT_ADMISSION_PERMISSION],
    trustedKeys: {
      'external-conformance-key': {
        publicKey,
        workspaceId: 'workspace-conformance',
        packageIds: ['pkg.external.conformance'],
        identitySubjects: ['connector:external-conformance'],
        identityKinds: ['connector'],
        notBefore: '2026-08-02T11:00:00.000Z',
        notAfter: '2026-08-02T13:00:00.000Z',
        revoked: false,
      },
    },
    clock: () => now,
    replayStore,
  });
  const input = {
    identity: { subject: 'connector:external-conformance', kind: 'connector' },
    workspaceId: 'workspace-conformance',
    package: pkg,
    signature,
  };
  const first = await enforceExternalClientAuthority(input, authority);
  assert(first.ok === true && first.decision === 'allow', 'first admission did not pass');
  assert(first.gate.gateVersion === 'tb-a6-v2', 'canonical gate version mismatch');
  assert(first.gate.receipt.packageFormat === 'huqan-package', 'gate receipt lost format');
  assert(first.gate.receipt.packageFormatVersion === '0.2', 'gate receipt lost formatVersion');
  assert(first.gate.receipt.packageProtocolVersion === '0.1',
    'gate receipt lost protocolVersion');
  assert(first.gate.receipt.atpVersion === null, 'canonical gate receipt exposed atpVersion');
  let replayError = null;
  try { await enforceExternalClientAuthority(input, authority); } catch (error) { replayError = error; }
  assert(replayError && replayError.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_DETECTED,
    `identical replay was not rejected with REPLAY_DETECTED: ${replayError && replayError.code}`);
});
