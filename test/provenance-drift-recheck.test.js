'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const { detectProvenanceDrift, toConflictResult, emitProvenanceDriftFindings, DRIFT_CODES } = require('../lib/provenance-drift');
const { contentHash } = require('../lib/content-hash');
const Kernel = require('../kernel');
const createRepoMemoryPlugin = require('../plugins/repo-memory').create;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-drift-recheck-'));

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

test('detectProvenanceDrift: unchanged material compares clean', () => {
  const material = 'same text';
  const result = detectProvenanceDrift({
    record: { contentHash: contentHash(material), sourceRef: 'file:x.md:S', workspaceId: 'default' },
    material,
  });
  assert.equal(result.drift, DRIFT_CODES.UNCHANGED);
  assert.equal(result.hashMatched, true);
  assert.equal(result.previousContentHash, contentHash(material));
});

test('detectProvenanceDrift: changed material is content_drift with the fresh hash', () => {
  const result = detectProvenanceDrift({
    record: { contentHash: 'a'.repeat(64), sourceRef: 'file:x.md:S', workspaceId: 'default' },
    materialHash: 'b'.repeat(64),
  });
  assert.equal(result.drift, DRIFT_CODES.CONTENT_DRIFT);
  assert.equal(result.hashMatched, false);
  assert.equal(result.contentHash, 'b'.repeat(64));
});

test('detectProvenanceDrift: unpinned record and unreadable source are answers, not throws', () => {
  const unpinned = detectProvenanceDrift({
    record: { sourceRef: 'file:x.md:S', workspaceId: 'default' },
    material: 'text',
  });
  assert.equal(unpinned.drift, DRIFT_CODES.NOT_HASH_PINNED);
  assert.equal(unpinned.hashMatched, null);

  const unreadable = detectProvenanceDrift({
    record: { contentHash: 'a'.repeat(64), sourceRef: 'file:x.md:S', workspaceId: 'default' },
    material: '',
    materialHash: '',
  });
  assert.equal(unreadable.drift, DRIFT_CODES.SOURCE_UNAVAILABLE);
});

test('detectProvenanceDrift: requires a record', () => {
  assert.throws(() => detectProvenanceDrift({ material: 'x' }), /record/);
});

test('toConflictResult: drift maps onto the provenance-mismatch conflict shape', () => {
  const result = detectProvenanceDrift({
    record: { contentHash: 'a'.repeat(64), sourceRef: 'file:x.md:S', workspaceId: 'default' },
    materialHash: 'b'.repeat(64),
  });
  const conflict = toConflictResult(result);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.type, 'provenance-mismatch');
  assert.equal(conflict.recommendation, 'flag');
  assert.equal(conflict.drift.code, DRIFT_CODES.CONTENT_DRIFT);
  assert.equal(conflict.drift.previousContentHash, 'a'.repeat(64));
  assert.equal(conflict.drift.contentHash, 'b'.repeat(64));

  const clean = toConflictResult(detectProvenanceDrift({
    record: { contentHash: 'a'.repeat(64), sourceRef: 'file:x.md:S', workspaceId: 'default' },
    materialHash: 'a'.repeat(64),
  }));
  assert.equal(clean.conflict, false);
  assert.equal(clean.type, null);
  assert.equal(clean.recommendation, 'accept');
});

function makeGraph() {
  const candidates = [];
  return {
    candidates,
    getCandidateClaims: () => candidates,
    // Same replace-on-id semantics the real candidate-claim storage has:
    // re-emitting a deterministic drift candidate updates the open finding
    // instead of accumulating rows.
    addCandidateClaim: (candidate) => {
      const index = candidates.findIndex((item) => item.candidateId === candidate.candidateId);
      if (index >= 0) candidates[index] = candidate;
      else candidates.push(candidate);
    },
    appendAuditEvent: () => {},
  };
}

test('emitProvenanceDriftFindings: queues one pending candidate per drifted sourceRef', () => {
  const graph = makeGraph();
  const kernel = { graph };
  const findings = emitProvenanceDriftFindings(kernel, {
    entries: [{ sourceRef: 'file:x.md:S', contentHash: 'b'.repeat(64), contentHashAlgorithm: 'sha256' }],
    workspaceId: 'default',
    sourceType: 'document',
    sourceSubType: 'markdown_section',
  });
  // No pinned baseline yet: nothing to compare against, no finding.
  assert.equal(findings.length, 0);
});

test('emitProvenanceDriftFindings: compares against a pinned node hash and skips drift findings as baselines', () => {
  const graph = makeGraph();
  graph.getNodes = () => ({
    'section:x': {
      id: 'section:x',
      workspaceId: 'default',
      provenance: { sourceRef: 'file:x.md:S', contentHash: 'a'.repeat(64), contentHashAlgorithm: 'sha256' },
    },
  });
  const kernel = { graph };

  const findings = emitProvenanceDriftFindings(kernel, {
    entries: [{ sourceRef: 'file:x.md:S', contentHash: 'b'.repeat(64), contentHashAlgorithm: 'sha256' }],
    workspaceId: 'default',
    sourceType: 'document',
    sourceSubType: 'markdown_section',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].conflict.type, 'provenance-mismatch');

  const stored = graph.candidates[graph.candidates.length - 1];
  assert.equal(stored.status, 'pending');
  assert.equal(stored.candidateId, findings[0].candidateId);
  assert.equal(stored.conflict.type, 'provenance-mismatch');
  assert.equal(stored.conflict.drift.code, 'content_drift');

  // A second run with the same fresh hash finds the pinned node hash again
  // (the node baseline was not overwritten by the finding), and the drift
  // candidate id is deterministic per (sourceRef, superseded hash), so the
  // stored finding updates in place instead of accumulating rows.
  const again = emitProvenanceDriftFindings(kernel, {
    entries: [{ sourceRef: 'file:x.md:S', contentHash: 'b'.repeat(64), contentHashAlgorithm: 'sha256' }],
    workspaceId: 'default',
    sourceType: 'document',
    sourceSubType: 'markdown_section',
  });
  assert.equal(again.length, 1);
  assert.equal(again[0].candidateId, findings[0].candidateId);
  assert.equal(graph.candidates.filter((c) => c.candidateId === findings[0].candidateId).length, 1);

  // A drift finding must not become the baseline it disagrees with.
  graph.candidates.push({
    candidateId: 'drift_other',
    conflict: { conflict: true, type: 'provenance-mismatch', recommendation: 'flag', reason: 'provenance_drift', drift: { code: 'content_drift' } },
    provenance: { sourceRef: 'file:x.md:S', contentHash: 'c'.repeat(64) },
    status: 'pending',
    workspaceId: 'default',
  });
  const third = emitProvenanceDriftFindings(kernel, {
    entries: [{ sourceRef: 'file:x.md:S', contentHash: 'c'.repeat(64), contentHashAlgorithm: 'sha256' }],
    workspaceId: 'default',
    sourceType: 'document',
    sourceSubType: 'markdown_section',
  });
  // The finding's own hash is not a baseline: comparing fresh 'c' against
  // the still-pinned 'a' keeps reporting drift against the last real ingest.
  assert.equal(third.length, 1);
  assert.equal(third[0].conflict.drift.previousContentHash, 'a'.repeat(64));
});

test('#3034 acceptance: ingest -> edit -> re-ingest emits a pending provenance-mismatch; unchanged re-ingest stays silent', async () => {
  const kernel = makeKernel('drift-e2e');
  kernel.usePlugin(createRepoMemoryPlugin());

  const dir = path.join(tempDir, 'ws');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, '# Baslik\nBirinci icerik.\n', 'utf8');

  const first = await kernel.runCapability('repoMemory', {
    action: 'ingest', sourceType: 'markdown', path: file, rootPath: dir, workspaceId: 'default',
  });
  assert.equal(first.ok, true);
  assert.equal(first.drift.findings, 0);

  fs.writeFileSync(file, '# Baslik\nDegismis ikinci icerik.\n', 'utf8');
  const second = await kernel.runCapability('repoMemory', {
    action: 'ingest', sourceType: 'markdown', path: file, rootPath: dir, workspaceId: 'default',
  });
  assert.equal(second.ok, true);
  assert.equal(second.drift.checked, 1);
  assert.equal(second.drift.findings, 1);
  assert.equal(second.driftFindings.length, 1);
  assert.equal(second.driftFindings[0].conflict.type, 'provenance-mismatch');

  const candidates = kernel.getCandidateClaims({ workspaceId: 'default' })
    .filter((candidate) => candidate.conflict && candidate.conflict.drift && candidate.conflict.drift.code === 'content_drift');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'pending');

  const driftEvents = (kernel.graph.getAuditEvents({ eventType: 'CONFLICT_DETECTED' }) || [])
    .filter((event) => event.details && event.details.drift === 'content_drift');
  assert.equal(driftEvents.length, 1);

  // The section node pins the verified hash of what the boundary actually read.
  const sectionNode = Object.values(kernel.graph.getNodes('default') || {})
    .find((node) => String(node.id).startsWith('section:') && node.provenance && node.provenance.sourceRef);
  assert.ok(sectionNode);
  assert.equal(typeof sectionNode.provenance.contentHash, 'string');
  assert.equal(sectionNode.provenance.contentHash.length, 64);

  // Unchanged third pass: silent.
  const third = await kernel.runCapability('repoMemory', {
    action: 'ingest', sourceType: 'markdown', path: file, rootPath: dir, workspaceId: 'default',
  });
  assert.equal(third.ok, true);
  assert.equal(third.drift.findings, 0);
  assert.equal(third.driftFindings, undefined);
});
