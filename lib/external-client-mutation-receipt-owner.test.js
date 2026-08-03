'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  stableStringify,
  sha256Hex,
} = require('./receipt/canonical-receipt');
const {
  buildCanonicalReceiptPayloadV2,
} = require('./receipt/canonical-receipt-v2');
const {
  V4_RECEIPT_ERROR_CODES,
} = require('./receipt/v4-receipt-family');
const {
  EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION,
  EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS,
  commitExternalClientCandidateClaim,
} = require('./external-client-mutation-receipt-owner');

const WORKSPACE_ID = 'workspace-external-1';
const PACKAGE_ID = 'package-external-1';
const IDENTITY_SUBJECT = 'agent:external-1';
const TRUSTED_KEY_ID = 'key-external-1';
const RESERVED_AT = Date.parse('2026-08-03T19:00:00.000Z');
const COLLECTIONS = [
  'provenanceRecords',
  'auditEvents',
  'candidateClaims',
  'conflictResults',
  'verificationResults',
  'trustReceipts',
  'causalChains',
  'simulationResults',
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function candidateFixture(overrides = {}) {
  const candidate = {
    candidateId: 'candidate-external-1',
    claim: 'External evidence proposes a bounded relationship.',
    proposedEdge: {
      from: 'external-subject',
      relation: 'CAUSES',
      to: 'external-object',
      confidence: 0.8,
      strength: 0.8,
      provenanceId: 'provenance-external-1',
      workspaceId: WORKSPACE_ID,
    },
    provenance: {
      provenanceId: 'provenance-external-1',
      sourceRef: 'external://package/package-external-1',
      sourceTitle: 'External signed candidate',
      sourceType: 'manual',
      sourceSubType: 'external-client',
      actor: IDENTITY_SUBJECT,
      timestamp: '2026-08-03T18:59:00.000Z',
      workspaceId: WORKSPACE_ID,
      confidence: 0.8,
      trustPolicyVersion: 'external-policy-1',
    },
    conflict: {
      conflict: false,
      type: null,
      recommendation: 'accept',
      reason: 'caller supplied and not locally authoritative',
      confidenceDelta: 0,
      existingEvidence: [],
      proposedEvidence: [],
      workspaceId: WORKSPACE_ID,
    },
    recommendation: 'accept',
    status: 'pending',
    workspaceId: WORKSPACE_ID,
    createdAt: '2026-08-03T18:59:00.000Z',
    reviewedAt: '2026-08-03T18:59:30.000Z',
    reviewedBy: 'external-reviewer',
    warnings: ['caller-warning'],
    canonical: false,
  };
  return Object.assign(candidate, overrides);
}

function packageFixture(candidate = candidateFixture(), objectOverrides = {}) {
  const objects = Object.fromEntries(COLLECTIONS.map((name) => [name, []]));
  objects.candidateClaims = [candidate];
  Object.assign(objects, objectOverrides);
  const objectCounts = Object.fromEntries(COLLECTIONS.map((name) => [
    name,
    Array.isArray(objects[name]) ? objects[name].length : 0,
  ]));
  return {
    manifest: {
      packageId: PACKAGE_ID,
      format: 'axiom-package',
      formatVersion: '0.1',
      createdAt: '2026-08-03T18:59:30.000Z',
      createdBy: IDENTITY_SUBJECT,
      workspaceId: WORKSPACE_ID,
      description: 'One external candidate quarantine package',
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
    metadata: {},
  };
}

function contextFixture(pkg, overrides = {}) {
  const packageHash = sha256Hex(stableStringify(pkg));
  const replayKey = `external-client-authority-0-v1:${sha256Hex('replay-owner-0')}`;
  const identity = { subject: IDENTITY_SUBJECT, kind: 'agent' };
  const authority = {
    authorityVersion: 'external-client-authority-0-v1',
    identity,
    workspaceId: WORKSPACE_ID,
    packageId: PACKAGE_ID,
    packageHash,
    trustedKeyId: TRUSTED_KEY_ID,
    permission: 'package:admit',
    reservedAt: RESERVED_AT,
    replayKey,
  };
  const context = {
    identity,
    workspaceId: WORKSPACE_ID,
    packageId: PACKAGE_ID,
    packageHash,
    signature: {
      algorithm: 'ed25519',
      keyId: TRUSTED_KEY_ID,
      verified: true,
    },
    gateVersion: 'tb-a6-v1',
    gateReceipt: {},
    authorityVersion: 'external-client-authority-0-v1',
    permission: 'package:admit',
    replayKey,
    authorityReceipt: {},
    authority,
  };
  return Object.assign(context, overrides);
}

function graphFixture(t, dbPath = null) {
  const directory = dbPath ? path.dirname(dbPath) : fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-owner-0-'));
  const resolvedDbPath = dbPath || path.join(directory, 'graph.db');
  const graph = new Graph({
    useSQLite: true,
    dbPath: resolvedDbPath,
    memoryPath: path.join(directory, 'graph.json'),
  });
  t.after(() => {
    try { graph.close(); } catch (_) {}
    if (!dbPath) fs.rmSync(directory, { recursive: true, force: true });
  });
  return { graph, directory, dbPath: resolvedDbPath };
}

function expectedLocalCandidateId(pkg) {
  const externalCandidateId = pkg.objects.candidateClaims[0].candidateId;
  return `external_candidate_${sha256Hex(stableStringify({
    ownerVersion: EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION,
    workspaceId: WORKSPACE_ID,
    packageHash: sha256Hex(stableStringify(pkg)),
    externalCandidateId,
  }))}`;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('commits one pending candidate, V2 receipt and journal atomically', (t) => {
  const { graph } = graphFixture(t);
  const pkg = packageFixture();
  const context = contextFixture(pkg);
  const result = commitExternalClientCandidateClaim(pkg, context, { graph });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'pending_review');
  assert.equal(result.replayed, false);
  assert.equal(Object.isFrozen(result), true);
  assert.match(result.operationId,
    /^external-client-candidate-claim:external-client-authority-0-v1:[a-f0-9]{64}$/);

  const candidates = graph.getCandidateClaims({ workspaceId: WORKSPACE_ID });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateId, result.localCandidateId);
  assert.equal(candidates[0].status, 'pending');
  assert.equal(candidates[0].recommendation, 'flag');
  assert.equal(candidates[0].conflict, null);
  assert.equal(candidates[0].reviewedAt, '');
  assert.equal(candidates[0].reviewedBy, '');
  assert.notEqual(candidates[0].candidateId, pkg.objects.candidateClaims[0].candidateId);

  const receipt = graph.getCommittedMutationReceiptByOperation(result.operationId);
  assert.equal(receipt.receiptId, result.receiptId);
  assert.equal(receipt.canonicalPayload.schemaVersion, 'v4-receipt-v2');
  assert.equal(receipt.canonicalPayload.trustRoot, 'external_verified_client');
  assert.equal(receipt.canonicalPayload.verdict, 'review');
  assert.equal(receipt.canonicalPayload.status, 'pending');
  assert.equal(receipt.canonicalPayload.createdAt, '2026-08-03T19:00:00.000Z');
  assert.equal(receipt.canonicalPayload.metadata.operationId, result.operationId);
  assert.equal(receipt.canonicalPayload.metadata.localCandidateId, result.localCandidateId);
  assert.equal(receipt.canonicalPayload.metadata.packageHash, context.packageHash);
  assert.equal(graph._stmts.getMutationJournal.get(result.operationId).status, 'completed');
});

test('same signed operation replays without a second mutation', (t) => {
  const { graph } = graphFixture(t);
  const pkg = packageFixture();
  const context = contextFixture(pkg);
  const first = commitExternalClientCandidateClaim(pkg, context, { graph });
  const second = commitExternalClientCandidateClaim(pkg, context, { graph });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.receiptHash, first.receiptHash);
  assert.equal(graph.getCandidateClaims({ workspaceId: WORKSPACE_ID }).length, 1);
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 1);
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_journal').get().count, 1);
});

test('committed operation and candidate survive close and reopen', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-owner-reopen-'));
  const dbPath = path.join(directory, 'graph.db');
  const firstGraph = new Graph({ useSQLite: true, dbPath, memoryPath: path.join(directory, 'graph.json') });
  const pkg = packageFixture();
  const context = contextFixture(pkg);
  const first = commitExternalClientCandidateClaim(pkg, context, { graph: firstGraph });
  firstGraph.close();

  const secondGraph = new Graph({ useSQLite: true, dbPath, memoryPath: path.join(directory, 'graph.json') });
  secondGraph.load();
  t.after(() => {
    secondGraph.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const second = commitExternalClientCandidateClaim(pkg, context, { graph: secondGraph });
  assert.equal(second.replayed, true);
  assert.equal(second.receiptHash, first.receiptHash);
  assert.equal(secondGraph.getCandidateClaims({ workspaceId: WORKSPACE_ID }).length, 1);
});

test('external recommendation, review and conflict authority are not imported', (t) => {
  const { graph } = graphFixture(t);
  const candidate = candidateFixture({
    recommendation: 'reject',
    reviewedBy: 'external-admin',
    reviewedAt: '2026-08-03T18:59:59.000Z',
    conflict: {
      conflict: true,
      type: 'agent-vs-graph',
      recommendation: 'reject',
      reason: 'external conclusion',
      confidenceDelta: -0.5,
      existingEvidence: [],
      proposedEvidence: [],
      workspaceId: WORKSPACE_ID,
    },
  });
  const pkg = packageFixture(candidate);
  const result = commitExternalClientCandidateClaim(pkg, contextFixture(pkg), { graph });
  const stored = graph.getCandidateClaims({ candidateId: result.localCandidateId, workspaceId: WORKSPACE_ID })[0];

  assert.equal(stored.recommendation, 'flag');
  assert.equal(stored.conflict, null);
  assert.equal(stored.reviewedBy, '');
  assert.equal(stored.reviewedAt, '');
  assert.deepEqual(stored.warnings, []);
});

test('zero, multiple or non-candidate embedded objects reject before mutation', (t) => {
  const { graph } = graphFixture(t);
  const zero = packageFixture(candidateFixture(), { candidateClaims: [] });
  expectCode(
    () => commitExternalClientCandidateClaim(zero, contextFixture(zero), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
  );

  const multiple = packageFixture(candidateFixture(), {
    candidateClaims: [candidateFixture(), candidateFixture({ candidateId: 'candidate-external-2' })],
  });
  expectCode(
    () => commitExternalClientCandidateClaim(multiple, contextFixture(multiple), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
  );

  const audit = packageFixture(candidateFixture(), {
    auditEvents: [{ auditId: 'not-local-authority' }],
  });
  expectCode(
    () => commitExternalClientCandidateClaim(audit, contextFixture(audit), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
  );
  assert.equal(graph.getCandidateClaims({ workspaceId: WORKSPACE_ID }).length, 0);
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_journal').get().count, 0);
});

test('accepted, rejected or canonical external candidates reject', (t) => {
  const { graph } = graphFixture(t);
  // A non-pending status clears package validation and is then caught by the
  // candidate semantic guard; canonical: true is rejected earlier, by package
  // validation itself. Both reject before any mutation.
  for (const [overrides, code] of [
    [{ status: 'accepted', canonical: true }, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID],
    [{ status: 'rejected', canonical: false }, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID],
    [{ status: 'pending', canonical: true }, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID],
  ]) {
    const pkg = packageFixture(candidateFixture(overrides));
    expectCode(
      () => commitExternalClientCandidateClaim(pkg, contextFixture(pkg), { graph }),
      code,
    );
  }
});

test('workspace, provenance actor and package authority mismatches reject', (t) => {
  const { graph } = graphFixture(t);

  const workspaceCandidate = candidateFixture();
  workspaceCandidate.proposedEdge.workspaceId = 'other-workspace';
  const workspacePkg = packageFixture(workspaceCandidate);
  expectCode(
    () => commitExternalClientCandidateClaim(workspacePkg, contextFixture(workspacePkg), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
  );

  const actorCandidate = candidateFixture();
  actorCandidate.provenance.actor = 'agent:spoofed';
  const actorPkg = packageFixture(actorCandidate);
  expectCode(
    () => commitExternalClientCandidateClaim(actorPkg, contextFixture(actorPkg), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
  );

  const pkg = packageFixture();
  const context = contextFixture(pkg);
  context.authority.packageHash = '0'.repeat(64);
  expectCode(
    () => commitExternalClientCandidateClaim(pkg, context, { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
  );
  assert.equal(graph.getCandidateClaims({ workspaceId: WORKSPACE_ID }).length, 0);
});

test('caller candidate ID cannot overwrite a derived local candidate', (t) => {
  const { graph } = graphFixture(t);
  const pkg = packageFixture();
  const localCandidateId = expectedLocalCandidateId(pkg);
  graph.addCandidateClaim({
    ...candidateFixture({ candidateId: localCandidateId, claim: 'pre-existing local record' }),
    recommendation: 'flag',
    status: 'pending',
    conflict: null,
  }, { workspaceId: WORKSPACE_ID });

  expectCode(
    () => commitExternalClientCandidateClaim(pkg, contextFixture(pkg), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.LOCAL_CANDIDATE_COLLISION,
  );
  const stored = graph.getCandidateClaims({ candidateId: localCandidateId, workspaceId: WORKSPACE_ID });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].claim, 'pre-existing local record');
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_journal').get().count, 0);
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);
});

test('forced post-mutation failure rolls back all rows and returns unknown outcome', (t) => {
  const { graph } = graphFixture(t);
  const pkg = packageFixture();
  const context = contextFixture(pkg);
  const original = graph.addCandidateClaim.bind(graph);
  graph.addCandidateClaim = (...args) => {
    original(...args);
    throw new Error('forced failure after candidate write');
  };

  expectCode(
    () => commitExternalClientCandidateClaim(pkg, context, { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN,
  );
  assert.equal(graph.getCandidateClaims({ workspaceId: WORKSPACE_ID }).length, 0);
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM candidate_claims').get().count, 0);
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_journal').get().count, 0);
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 0);
});

test('unrelated V2 writes remain fail closed while V1 behavior is unchanged', (t) => {
  const { graph } = graphFixture(t);
  const raw = {
    receiptId: 'receipt-unrelated-v2',
    receiptKind: 'unrelated',
    decision: 'allow',
    status: 'allowed',
    admissionId: 'admission-unrelated',
    workspaceId: WORKSPACE_ID,
    actor: 'local',
    agentId: 'local',
    memoryDraftId: '',
    provenanceId: 'prov-unrelated',
    trustPolicyVersion: '1.0.0',
    approvalId: '',
    approvalStatus: '',
    reason: '',
    riskScore: 0,
    createdAt: '2026-08-03T19:00:00.000Z',
    metadata: {},
  };
  const v2 = buildCanonicalReceiptPayloadV2(raw, {
    verdict: 'allow',
    trustRoot: 'local_operator',
  });
  assert.throws(() => graph.runMutationOnce('unrelated-operation', () => ({ ok: true }), {
    buildCanonicalReceipt: () => v2,
  }), (error) => error.code === V4_RECEIPT_ERROR_CODES.WRITE_NOT_ENABLED);
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_journal').get().count, 0);
});

test('tampered committed-result bindings fail closed without another mutation', (t) => {
  const { graph } = graphFixture(t);
  const pkg = packageFixture();
  const context = contextFixture(pkg);
  const first = commitExternalClientCandidateClaim(pkg, context, { graph });
  graph._db.prepare('UPDATE mutation_journal SET result = ? WHERE operation_id = ?').run(
    JSON.stringify({ outcome: 'forged' }),
    first.operationId,
  );

  expectCode(
    () => commitExternalClientCandidateClaim(pkg, context, { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN,
  );
  assert.equal(graph.getCandidateClaims({ workspaceId: WORKSPACE_ID }).length, 1);
  assert.equal(graph._db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get().count, 1);
});

test('accessors, symbols, proxies and extended arrays fail closed', (t) => {
  const { graph } = graphFixture(t);

  const accessorPackage = packageFixture();
  Object.defineProperty(accessorPackage.manifest, 'packageId', {
    enumerable: true,
    get() { return PACKAGE_ID; },
  });
  expectCode(
    () => commitExternalClientCandidateClaim(accessorPackage, contextFixture(packageFixture()), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
  );

  const symbolPackage = packageFixture();
  symbolPackage[Symbol('hidden')] = true;
  expectCode(
    () => commitExternalClientCandidateClaim(symbolPackage, contextFixture(packageFixture()), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
  );

  const proxyPackage = new Proxy(packageFixture(), {
    ownKeys() { throw new Error('hostile ownKeys'); },
  });
  expectCode(
    () => commitExternalClientCandidateClaim(proxyPackage, contextFixture(packageFixture()), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
  );

  const extendedArrayPackage = packageFixture();
  extendedArrayPackage.objects.candidateClaims.extra = true;
  expectCode(
    () => commitExternalClientCandidateClaim(extendedArrayPackage, contextFixture(packageFixture()), { graph }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
  );
  assert.equal(graph.getCandidateClaims({ workspaceId: WORKSPACE_ID }).length, 0);
});

test('input snapshots are not mutated and outputs are frozen', (t) => {
  const { graph } = graphFixture(t);
  const pkg = packageFixture();
  const context = contextFixture(pkg);
  const beforePackage = stableStringify(pkg);
  const beforeContext = stableStringify(context);
  const result = commitExternalClientCandidateClaim(pkg, context, { graph });

  assert.equal(stableStringify(pkg), beforePackage);
  assert.equal(stableStringify(context), beforeContext);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(graph.getCommittedMutationReceiptByOperation(result.operationId).canonicalPayload), false);
});

test('owner remains internal and published receipt module has no owner dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const guardSource = fs.readFileSync(path.join(__dirname, 'receipt', 'v4-receipt-family.js'), 'utf8');
  const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');

  assert.equal(packageJson.files.includes('lib/external-client-mutation-receipt-owner.js'), false);
  assert.equal(guardSource.includes("require('../external-client-mutation-receipt-owner')"), false);
  assert.equal(guardSource.includes("require('./external-client-mutation-receipt-owner')"), false);
  assert.equal(graphSource.includes('external-client-mutation-receipt-owner'), false);
});

test('graph dependency and context shapes are exact', () => {
  const pkg = packageFixture();
  const context = contextFixture(pkg);
  expectCode(
    () => commitExternalClientCandidateClaim(pkg, context, {}),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.GRAPH_REQUIRED,
  );
  const extended = clone(context);
  extended.requestBodyAuthority = true;
  expectCode(
    () => commitExternalClientCandidateClaim(pkg, extended, {
      graph: {
        runMutationOnce() {},
        addCandidateClaim() {},
        getCandidateClaims() { return []; },
      },
    }),
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
  );
});
