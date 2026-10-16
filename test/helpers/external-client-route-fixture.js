'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../../graph');
const { stableStringify } = require('../../lib/receipt/canonical-receipt');
const { createHuqanPackage } = require('../../lib/huqan-package-format');
const { materializeExternalClientTrustConfig, EXTERNAL_CLIENT_TRUST_CONFIG_VERSION } = require('../../lib/external-client-trust-config');
const { createExternalClientReplayStore } = require('../../lib/external-client-replay-store');
const { createHuqanClient } = require('../../lib/sdk');
const { commitExternalClientCandidateClaim } = require('../../lib/external-client-mutation-receipt-owner');
const { createExternalClientHttpAdapter } = require('../../lib/external-client-http-adapter');
const { snapshotAgentIdentityAuthority } = require('../../lib/agent-identity-runtime');
const minimalAgentIdentity = require('../fixtures/v5/agent-identity/valid.minimal.json');
const COLLECTIONS = ['provenanceRecords','auditEvents','candidateClaims','conflictResults','verificationResults','trustReceipts','causalChains','simulationResults'];
const IDS = Object.freeze({
  workspaceId: 'workspace-route-a', packageId: 'pkg.route.workspace-a',
  identitySubject: 'connector:route-test', identityKind: 'connector', keyId: 'route-key-1',
});
const NOW = Date.parse('2026-08-04T18:00:00.000Z');
function candidate() {
  return {
    candidateId: 'candidate-route-external-1', claim: 'Signed route evidence proposes one bounded relation.',
    proposedEdge: { from: 'route-subject', relation: 'CAUSES', to: 'route-object', confidence: 0.8,
      strength: 0.8, provenanceId: 'route-provenance-1', workspaceId: IDS.workspaceId },
    provenance: { provenanceId: 'route-provenance-1', sourceRef: 'external://route/package',
      sourceTitle: 'Route signed candidate', sourceType: 'manual', sourceSubType: 'external-client',
      actor: IDS.identitySubject, timestamp: '2026-08-04T17:59:00.000Z', workspaceId: IDS.workspaceId,
      confidence: 0.8, trustPolicyVersion: 'route-policy-1' },
    conflict: { conflict: false, type: null, recommendation: 'accept', reason: 'caller-only',
      confidenceDelta: 0, existingEvidence: [], proposedEvidence: [], workspaceId: IDS.workspaceId },
    recommendation: 'accept', status: 'pending', workspaceId: IDS.workspaceId,
    createdAt: '2026-08-04T17:59:00.000Z', reviewedAt: '', reviewedBy: '', warnings: [], canonical: false,
  };
}
function packageValue(overrides = {}) {
  const objects = Object.fromEntries(COLLECTIONS.map((name) => [name, []]));
  objects.candidateClaims = [candidate()];
  const objectCounts = Object.fromEntries(COLLECTIONS.map((name) => [name, objects[name].length]));
  const value = {
    manifest: { packageId: IDS.packageId, format: 'axiom-package', formatVersion: '0.1',
      createdAt: '2026-08-04T17:59:00.000Z', createdBy: IDS.identitySubject,
      workspaceId: IDS.workspaceId, source: { type: 'test', sourceRef: 'huqan://route/package' },
      description: 'Route adversarial candidate package',
      atpVersion: '0.1', objectCounts },
    objects, index: { byId: {}, bySourceRef: {}, byWorkspaceId: {}, byType: {} },
    metadata: { warnings: [] },
  };
  if (overrides.manifest) Object.assign(value.manifest, overrides.manifest);
  if (overrides.candidate) Object.assign(value.objects.candidateClaims[0], overrides.candidate);
  return overrides.canonical ? createHuqanPackage(value) : value;
}
function sign(pkg, privateKey, keyId = IDS.keyId) {
  return { algorithm: 'ed25519', keyId,
    value: crypto.sign(null, Buffer.from(stableStringify(pkg), 'utf8'), privateKey).toString('base64') };
}
function profileInput(keys, overrides = {}) {
  return {
    profileVersion: EXTERNAL_CLIENT_TRUST_CONFIG_VERSION,
    expectedIdentitySubject: IDS.identitySubject, expectedIdentityKind: IDS.identityKind,
    expectedWorkspaceId: IDS.workspaceId, expectedPackageId: IDS.packageId,
    permissions: ['package:admit'],
    trustedKeys: { [IDS.keyId]: { publicKeySpkiDer: keys.publicKey.export({ format: 'der', type: 'spki' }),
      workspaceId: IDS.workspaceId, packageIds: [IDS.packageId], identitySubjects: [IDS.identitySubject],
      identityKinds: [IDS.identityKind], notBefore: '2026-08-04T17:00:00.000Z',
      notAfter: '2026-08-04T19:00:00.000Z', revoked: false, ...overrides } },
  };
}
function frozenSdkResult(admission) {
  return Object.freeze({ ok: true, gate: Object.freeze({ decision: 'allow' }),
    authority: Object.freeze({ decision: 'allow' }), admission });
}
function createRouteFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-route-'));
  const graphPath = path.join(directory, 'graph.db');
  const replayPath = path.join(directory, 'replay.db');
  const graph = new Graph({ useSQLite: true, dbPath: graphPath, memoryPath: path.join(directory, 'graph.json') });
  const keys = crypto.generateKeyPairSync('ed25519');
  const materializeProfile = (overrides = {}) => materializeExternalClientTrustConfig(profileInput(keys, overrides));
  const profile = materializeProfile();
  let replayStore;
  let client;
  let adapter;
  let handlerCalls = 0;
  let replayCalls = 0;
  const contexts = [];
  const build = () => {
    replayStore = createExternalClientReplayStore({ dbPath: replayPath });
    const replayOwner = options.replayReserve
      ? { reserve: async (record) => { replayCalls += 1; return options.replayReserve(record); } }
      : replayStore;
    client = createHuqanClient({}, { ...profile, clock: () => NOW, replayStore: replayOwner,
      packageAdmissionHandler: (pkg, context) => {
        handlerCalls += 1; contexts.push(context);
        if (options.handlerError) throw options.handlerError;
        return commitExternalClientCandidateClaim(pkg, context, {
          graph,
          ...(Object.hasOwn(options, 'agentIdentityRuntime')
            ? { agentIdentityRuntime: options.agentIdentityRuntime }
            : {}),
        });
      } });
    adapter = createExternalClientHttpAdapter({ admitPackage: (input) => client.admitExternalPackage({
      identity: { subject: IDS.identitySubject, kind: IDS.identityKind },
      workspaceId: IDS.workspaceId, package: input.package, signature: input.signature,
    }) });
  };
  build();
  const state = () => {
    const candidates = graph.getCandidateClaims({ workspaceId: IDS.workspaceId });
    const journals = graph._db.prepare('SELECT operation_id, status, result FROM mutation_journal ORDER BY operation_id').all();
    const receipts = graph._db.prepare('SELECT operation_id, receipt_id, canonical_payload, receipt_hash FROM mutation_receipts ORDER BY sequence').all();
    return { candidates, journals, receipts: receipts.map((row) => ({ ...row, canonicalPayload: JSON.parse(row.canonical_payload) })) };
  };
  const envelope = (pkg = packageValue(), signature = sign(pkg, keys.privateKey)) => ({ package: pkg, signature });
  const restartReplay = () => { replayStore.close(); build(); };
  const journalReplayAdapter = () => createExternalClientHttpAdapter({ admitPackage: async (input) => {
    if (!contexts[0]) throw new Error('authoritative context unavailable');
    return frozenSdkResult(commitExternalClientCandidateClaim(input.package, contexts[0], { graph }));
  } });
  const cleanup = () => {
    try { replayStore?.close(); } catch (_) {}
    try { graph.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  };
  if (t) t.after(cleanup);
  return {
    IDS, NOW, directory, graph, replayPath, profile, keys, packageValue, sign, envelope, state,
    get adapter() { return adapter; }, get handlerCalls() { return handlerCalls; },
    get replayCalls() { return replayCalls; }, get contexts() { return contexts; },
    restartReplay, journalReplayAdapter, materializeProfile, cleanup,
  };
}
function routeIdentityAuthority(ownerActorId = 'connector:route-test', recordOverrides = {}) {
  return snapshotAgentIdentityAuthority({
    workspaceId: 'workspace-route-a',
    identities: [{ ref: 'identity:route-agent', record: {
      ...minimalAgentIdentity,
      agent_id: `agent-route-${ownerActorId.replace(/[^a-z0-9]+/gi, '-')}`,
      agent_type: 'connector-agent', owner_actor_id: ownerActorId, workspace_id: 'workspace-route-a',
      delegation_scope: ['external-client.commitCandidateClaim'], allowed_tools: ['external-client'],
      allowed_connectors: ['connector'], policy_version: 'route-identity-policy-1',
      ...recordOverrides,
    } }],
    clock: () => Date.parse('2026-08-04T18:00:00.000Z'),
  });
}
function routeIdentityRuntime(authority) {
  return { authority, identityRef: 'identity:route-agent', action: {
    capability: 'external-client.commitCandidateClaim', target: 'external://route/package', riskTier: 'low',
    tool: 'external-client', connector: 'connector',
  } };
}
module.exports = { IDS, NOW, packageValue, sign, createRouteFixture, routeIdentityAuthority, routeIdentityRuntime };
