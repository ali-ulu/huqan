const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const { buildProvenance } = require('./provenance-ingest');

const APPROVED_TEST_ADMISSION = {
  admissionRequired: true,
  approvalRequired: true,
  approvalStatus: 'approved',
  approvalId: 'apr-lib-provenance-ingest-test',
};

function tempPaths(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
  };
}

test('buildProvenance auto-fills missing fields in non-strict compatibility mode', () => {
  const { provenance, warnings } = buildProvenance({
    sourceType: 'document',
    sourceRef: 'docs/adr.md#claim',
  }, {
    strictProvenance: false,
  });

  assert.strictEqual(provenance.sourceType, 'document');
  assert.strictEqual(provenance.confidence, 0.8);
  assert.strictEqual(provenance.trustPolicyVersion, '0.8.0');
  assert.ok(provenance.provenanceId);
  assert.ok(provenance.actor);
  assert.ok(provenance.timestamp);
  assert.ok(provenance.workspaceId);
  assert.ok(warnings.length > 0);
  assert.ok(warnings.some(item => item.includes('confidence auto-filled')));
  assert.ok(warnings.some(item => item.includes('sourceTitle auto-filled')));
  assert.ok(warnings.some(item => item.includes('workspaceId auto-filled')));
});

test('buildProvenance uses github subtype defaults', () => {
  const { provenance } = buildProvenance({
    sourceType: 'github',
    sourceSubType: 'release_tag',
    sourceRef: 'github.com/agiulucom42-del/axiom/releases/tag/v0.7.0',
    sourceTitle: 'AXIOM v0.7.0',
  });

  assert.strictEqual(provenance.confidence, 0.9);
  assert.strictEqual(provenance.trustPolicyVersion, '0.8.0');
});

test('buildProvenance preserves explicit confidence and rejects empty strict input', () => {
  const explicit = buildProvenance({
    sourceType: 'user',
    sourceRef: 'user-note',
    confidence: 0.97,
  });
  assert.strictEqual(explicit.provenance.confidence, 0.97);

  assert.throws(() => buildProvenance({}, { strictProvenance: true }), {
    name: 'ProvenanceError',
    code: 'PROVENANCE_REQUIRED',
  });
});

test('buildProvenance records an invalid sourceType as invalid, not as system (#742)', () => {
  const { provenance, warnings } = buildProvenance({
    sourceType: 'bogus',
    sourceRef: 'docs/adr.md#claim',
    sourceTitle: 'Bad provenance',
    confidence: 1.4,
  });

  // It used to be rewritten to 'system' at that type's 0.5 weight, which is
  // exactly the floor where the source-based review gate stops firing.
  assert.strictEqual(provenance.sourceType, 'invalid');
  assert.strictEqual(provenance.rejectedSourceType, 'bogus');
  assert.strictEqual(provenance.confidence, 0.2);
  assert.ok(warnings.some(item => item.includes('invalid sourceType')));
  assert.ok(warnings.some(item => item.includes('confidence clamped')));
});

test('buildProvenance rejects invalid sourceType and confidence in strict mode', () => {
  assert.throws(() => buildProvenance({
    sourceType: 'bogus',
    sourceRef: 'docs/adr.md#claim',
    sourceTitle: 'Bad provenance',
    confidence: 1.4,
  }, { strictProvenance: true }), {
    name: 'ProvenanceError',
    code: 'PROVENANCE_REQUIRED',
  });
});

// The live learn sites build provenance and hand it to kernel.learn directly
// (the kernel.learn adapter was removed unwired, #3315). These tests pin that
// the built provenance survives the write and both persistence roundtrips.
function learnWithBuiltProvenance(kernel, text, provenanceInput, opts = {}) {
  const built = buildProvenance(provenanceInput, {});
  kernel.learn(text, {
    ...opts,
    provenance: built.provenance,
    sourceType: built.provenance.sourceType,
    ...(built.provenance.sourceSubType ? { sourceSubType: built.provenance.sourceSubType } : {}),
    workspaceId: built.provenance.workspaceId,
  });
  return built;
}

test('built provenance is written to the learned nodes and edges', async () => {
  const paths = tempPaths('axiom-prov-memory-');
  try {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: paths.memoryPath });
    const built = learnWithBuiltProvenance(kernel, 'kedi hayvandir', {
        sourceType: 'document',
        sourceRef: 'docs/adr.md#claim',
        sourceTitle: 'Trust Claim',
      }, APPROVED_TEST_ADMISSION);

    assert.ok(built.warnings.length > 0, 'the sparse input is auto-filled, with warnings');

    const node = kernel.graph.getNode('kedi');
    const edge = kernel.graph.getEdge('kedi', 'hayvan', 'tür');
    assert.strictEqual(node.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(edge.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(node.provenance.confidence, 0.8);
    assert.strictEqual(edge.provenance.confidence, 0.8);
    assert.strictEqual(node.provenance.sourceRef, 'docs/adr.md#claim');
    assert.strictEqual(edge.provenance.sourceRef, 'docs/adr.md#claim');
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('built provenance survives the JSON roundtrip', async () => {
  const paths = tempPaths('axiom-prov-json-');
  try {
    const writer = new Kernel({ noLoad: true, useSQLite: false, memoryPath: paths.memoryPath });
    learnWithBuiltProvenance(writer, 'kedi hayvandir', {
        sourceType: 'document',
        sourceRef: 'docs/adr.md#claim',
        sourceTitle: 'Trust Claim',
      }, APPROVED_TEST_ADMISSION);
    writer.graph.save();

    const reader = new Kernel({ useSQLite: false, memoryPath: paths.memoryPath });
    const node = reader.graph.getNode('kedi');
    const edge = reader.graph.getEdge('kedi', 'hayvan', 'tür');

    assert.strictEqual(node.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(edge.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(edge.provenance.sourceRef, 'docs/adr.md#claim');
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('built provenance survives the SQLite roundtrip', async (t) => {
  const paths = tempPaths('axiom-prov-sqlite-');
  const writer = new Kernel({ noLoad: true, useSQLite: true, memoryPath: paths.memoryPath, dbPath: paths.dbPath });
  if (writer.graph.getStats().backend !== 'sqlite') {
    writer.graph.close();
    fs.rmSync(paths.dir, { recursive: true, force: true });
    return t.skip('better-sqlite3 is unavailable');
  }

  const reader = new Kernel({ useSQLite: true, memoryPath: paths.memoryPath, dbPath: paths.dbPath });
  t.after(() => {
    writer.graph.close();
    reader.graph.close();
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  learnWithBuiltProvenance(writer, 'kedi hayvandir', {
      sourceType: 'github',
      sourceSubType: 'release_tag',
      sourceRef: 'github.com/agiulucom42-del/axiom/releases/tag/v0.7.0',
      sourceTitle: 'AXIOM v0.7.0',
    }, APPROVED_TEST_ADMISSION);
  writer.graph.save();
  reader.graph.load();

  const node = reader.graph.getNode('kedi');
  const edge = reader.graph.getEdge('kedi', 'hayvan', 'tür');

  assert.strictEqual(node.provenance.trustPolicyVersion, '0.8.0');
  assert.strictEqual(edge.provenance.trustPolicyVersion, '0.8.0');
  assert.strictEqual(node.provenance.confidence, 0.9);
  assert.strictEqual(edge.provenance.confidence, 0.9);
  assert.strictEqual(edge.provenance.sourceRef, 'github.com/agiulucom42-del/axiom/releases/tag/v0.7.0');
});
