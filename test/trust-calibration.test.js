'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const {
  runTrustCalibration,
  journalTrustCalibration,
  buildMemoryHealthSummary,
  deriveCalibrationVerdict,
  CALIBRATION_SCHEMA_VERSION,
} = require('../lib/trust-calibration');
const Kernel = require('../kernel');
const createRepoMemoryPlugin = require('../plugins/repo-memory').create;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-trust-calibration-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

function makeKernel(label) {
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${label}.json`),
    capabilities: {
      companyMode: true,
      pluginCapabilities: true,
      evidenceRanking: true,
      temporal: true,
    },
  });
}

function writeAuditEvent(graph, event) {
  graph.appendAuditEvent(event, { workspaceId: event.workspaceId || 'default' });
}

test('runTrustCalibration: requires a graph', () => {
  assert.throws(() => runTrustCalibration(null), /graph/);
});

// A threshold that gates a trust decision must fail closed: a non-finite or
// negative minOutcomes used to make `totalOutcomes >= minOutcomes` silently
// false and switch the downgrade off. It must throw instead.
test('calibration thresholds fail closed on a non-finite or negative value', () => {
  const records = [{ declared: 0.9 }, { declared: 0.8 }];
  for (const bad of [NaN, Infinity, -Infinity, -1, '5', null]) {
    assert.throws(
      () => deriveCalibrationVerdict({ actor: 'a', sourceType: 'github', records, verified: 0, contradicted: 9, minOutcomes: bad }),
      /minOutcomes must be a finite, non-negative number/,
      `deriveCalibrationVerdict accepted minOutcomes=${String(bad)}`,
    );
  }
  // A finite, non-negative threshold still works.
  const ok = deriveCalibrationVerdict({ actor: 'a', sourceType: 'github', records, verified: 0, contradicted: 9, minOutcomes: 5 });
  assert.ok(ok.suggestedCap !== null);
});

test('runTrustCalibration and the kernel passthrough reject a non-finite minOutcomes', () => {
  const kernel = makeKernel('calibration-threshold');
  kernel.graph.addNode('n-threshold', 'n-threshold', {
    provenanceId: 'prov_threshold', sourceRef: 'file:t.md:S', sourceType: 'document',
    actor: 'actorT', workspaceId: 'default', declaredConfidence: 0.9, confidence: 0.8,
  }, { workspaceId: 'default' });
  assert.throws(() => runTrustCalibration(kernel.graph, { workspaceId: 'default', minOutcomes: NaN }), /minOutcomes must be a finite/);
  assert.throws(() => kernel.calibrateTrustPolicy({ workspaceId: 'default', minOutcomes: NaN }), /minOutcomes must be a finite/);
  assert.throws(() => kernel.calibrateTrustPolicy({ workspaceId: 'default', minOutcomes: -1 }), /minOutcomes must be a finite/);
  // The default and a valid explicit threshold still produce a report.
  assert.ok(kernel.calibrateTrustPolicy({ workspaceId: 'default' }).pairs >= 1);
  assert.ok(kernel.calibrateTrustPolicy({ workspaceId: 'default', minOutcomes: 3 }).pairs >= 1);
});

test('deriveCalibrationVerdict: no suggested cap without enough contradicting outcomes', () => {
  const records = [{ declared: 0.9 }, { declared: 0.8 }];
  const few = deriveCalibrationVerdict({ actor: 'a', sourceType: 'github', records, verified: 0, contradicted: 3, minOutcomes: 5 });
  assert.equal(few.suggestedCap, null);

  const majority = deriveCalibrationVerdict({ actor: 'a', sourceType: 'github', records, verified: 1, contradicted: 9, minOutcomes: 5 });
  assert.ok(majority.suggestedCap !== null);
  assert.ok(majority.suggestedCap <= majority.maxDeclared);
  assert.ok(majority.reason.includes('suggest'));
});

test('runTrustCalibration: pairs declared confidence with outcomes per actor+sourceType', () => {
  const kernel = makeKernel('calibration-pairs');
  const { graph } = kernel;

  // A node whose provenance carries a declared confidence (the ingest
  // boundary stamped it) plus matching audit outcomes.
  graph.addNode('n1', 'n1', {
    provenanceId: 'prov_1',
    sourceRef: 'file:x.md:S',
    sourceType: 'document',
    actor: 'actorA',
    workspaceId: 'default',
    declaredConfidence: 0.9,
    confidence: 0.8,
  }, { workspaceId: 'default' });

  writeAuditEvent(graph, {
    eventType: 'CLAIM_REJECTED', targetType: 'candidate_claim', targetId: 'c1',
    details: { actor: 'actorA', sourceType: 'document' }, workspaceId: 'default',
  });
  for (let i = 0; i < 6; i += 1) {
    writeAuditEvent(graph, {
      eventType: 'CLAIM_FLAGGED', targetType: 'candidate_claim', targetId: `cf${i}`,
      details: { actor: 'actorA', sourceType: 'document' }, workspaceId: 'default',
    });
  }

  const report = kernel.calibrateTrustPolicy({ workspaceId: 'default' });
  assert.equal(report.schemaVersion, CALIBRATION_SCHEMA_VERSION);
  assert.equal(report.pairs, 1);
  const verdict = report.verdicts.find((v) => v.actor === 'actorA' && v.sourceType === 'document');
  assert.ok(verdict);
  assert.equal(verdict.contradicted, 7);
  assert.equal(verdict.verified, 0);
  assert.equal(verdict.sampledCount, 1);
  // 7 contradicting outcomes >= minOutcomes with agreementRate 0: the cap
  // suggestion fires, and floors at 0 rather than staying null.
  assert.equal(verdict.suggestedCap, 0);
});

test('runTrustCalibration: high declared confidence with heavy contradiction suggests a lower cap', () => {
  const kernel = makeKernel('calibration-downgrade');
  const { graph } = kernel;
  graph.addNode('n2', 'n2', {
    provenanceId: 'prov_2',
    sourceRef: 'file:y.md:S',
    sourceType: 'document',
    actor: 'actorB',
    workspaceId: 'default',
    declaredConfidence: 0.95,
    confidence: 0.8,
  }, { workspaceId: 'default' });
  for (let i = 0; i < 8; i += 1) {
    writeAuditEvent(graph, {
      eventType: 'CLAIM_FLAGGED', targetType: 'candidate_claim', targetId: `b${i}`,
      details: { actor: 'actorB', sourceType: 'document' }, workspaceId: 'default',
    });
  }
  const report = kernel.calibrateTrustPolicy({ workspaceId: 'default', minOutcomes: 5 });
  const verdict = report.verdicts.find((v) => v.actor === 'actorB');
  assert.ok(verdict);
  assert.equal(verdict.verified, 0);
  assert.equal(verdict.contradicted, 8);
  assert.ok(verdict.suggestedCap !== null);
  assert.ok(verdict.suggestedCap < 0.95);
  assert.equal(report.suggestCapCount, 1);
});

test('journalTrustCalibration: one durable row per verdict, replay on re-run', () => {
  const kernel = makeKernel('calibration-journal');
  const { graph } = kernel;
  graph.addNode('n3', 'n3', {
    provenanceId: 'prov_3',
    sourceRef: 'file:z.md:S',
    sourceType: 'github',
    actor: 'actorC',
    workspaceId: 'default',
    declaredConfidence: 0.7,
    confidence: 0.7,
  }, { workspaceId: 'default' });
  const report = kernel.calibrateTrustPolicy({ workspaceId: 'default' });
  const first = kernel.journalTrustCalibration(report);
  assert.equal(first.journaled, 1);
  const second = kernel.journalTrustCalibration(report);
  assert.equal(second.replayed, 1);
});

test('#3034 acceptance: memory health aggregates drift findings and conflict candidates', async () => {
  const kernel = makeKernel('memory-health');
  kernel.usePlugin(createRepoMemoryPlugin());

  const dir = path.join(tempDir, 'ws-health');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, '# Baslik\nIlk icerik.\n', 'utf8');
  await kernel.runCapability('repoMemory', { action: 'ingest', sourceType: 'markdown', path: file, rootPath: dir, workspaceId: 'default' });
  fs.writeFileSync(file, '# Baslik\nBaska icerik.\n', 'utf8');
  await kernel.runCapability('repoMemory', { action: 'ingest', sourceType: 'markdown', path: file, rootPath: dir, workspaceId: 'default' });

  const health = kernel.memoryHealth('default');
  assert.equal(health.schemaVersion, 'huqan-memory-health-v1');
  assert.equal(health.driftFindings.pending, 1);
  assert.ok(health.lastCheckedAt);

  // AC3 surface: the calibration report is reachable from the same kernel.
  const report = kernel.calibrateTrustPolicy({ workspaceId: 'default' });
  assert.ok(report.pairs >= 1);
});

test('#3034 acceptance: causal conflict blocks as a pending candidate until a human resolves it', () => {
  const kernel = makeKernel('memory-health-conflict');
  const { graph } = kernel;

  // The canonical edge says A CAUSES B; a challenger proposes A PREVENTS B.
  graph.addNode('A', 'A', null, { workspaceId: 'default' });
  graph.addNode('B', 'B', null, { workspaceId: 'default' });
  graph.addEdge('A', 'B', 'CAUSES', { workspaceId: 'default', strength: 0.7 });

  const routed = kernel.ingestCandidateClaim({
    claim: 'A PREVENTS B',
    subject: 'A',
    relation: 'PREVENTS',
    object: 'B',
    sourceRef: 'file:conflict.md:S',
    sourceType: 'document',
    actor: 'challenger',
    confidence: 0.8,
  }, { workspaceId: 'default' });

  const status = routed.candidate.status || routed.status;
  assert.equal(status, 'pending');
  assert.equal(routed.conflict.type, 'agent-vs-causal');

  const health = kernel.memoryHealth('default');
  assert.equal(health.conflictCandidates.pending, 1);
  assert.equal(health.conflictsByType['agent-vs-causal'], 1);

  // Human resolution via the existing review path clears the contest.
  const review = require('../lib/conflict-candidate-review').reviewConflictCandidate(kernel, {
    candidateId: routed.candidate.candidateId,
    decision: 'reject',
    reviewer: 'test:human',
    workspaceId: 'default',
  });
  assert.equal(review.status, 'rejected');

  const after = kernel.memoryHealth('default');
  assert.equal(after.conflictCandidates.pending, 0);
  assert.equal(after.conflictCandidates.rejected, 1);
});
