const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const Kernel = require('../kernel');
const {
  partitionSignalsByKind,
  enforceEvidencedContradiction,
} = require('../lib/verify-contradiction-evidence');

function makeKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-verify-contradiction-'));
  return new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(dir, 'memory.json'),
  });
}

function seedKernel() {
  const kernel = makeKernel();
  for (const node of ['kedi', 'hayvan', 'süt']) kernel.graph.addNode(node);
  kernel.graph.addEdge('kedi', 'hayvan', 'tür', { weight: 0.9 });
  kernel.graph.addEdge('kedi', 'süt', 'içer', { weight: 0.9 });
  return kernel;
}

test('#1619 conformance: verify never answers contradicted without evidence', () => {
  const kernel = seedKernel();
  const claims = [
    'kedi su içer',
    'kedi kahve içer',
    'kedi bir hayvandır',
    'kedi bir bitkidir',
    'kedi uçabilir',
    'kedi süt sever',
    'kedi hayvan kullanir',
  ];

  for (const claim of claims) {
    const result = kernel.verify(claim);
    const evidence = Array.isArray(result.evidence) ? result.evidence : [];
    if (result.data.status === 'contradicted') {
      assert.ok(
        evidence.length > 0,
        `"${claim}" was refuted with no evidence -- an unfalsifiable contradiction (#1619)`,
      );
    }
  }
});

test('#1619 a differently worded fact about a known subject is unknown, not refuted', () => {
  const kernel = seedKernel();
  // The graph knows `kedi --içer--> süt`. "kedi su içer" is a different fact
  // about the same subject, not a refutation of the stored one.
  const result = kernel.verify('kedi su içer');
  assert.strictEqual(result.data.status, 'unknown');
  assert.deepStrictEqual(result.evidence, []);
  // The drift is still surfaced for review, just not as a verdict.
  assert.ok(result.meta.semanticTrust.warnings.includes('PREDICATE_DRIFT'));
});

test('#1619 genuine type conflicts still refute, with their evidence intact', () => {
  const kernel = seedKernel();
  const result = kernel.verify('kedi bir bitkidir');
  assert.strictEqual(result.data.status, 'contradicted');
  assert.ok(result.evidence.length > 0);
});

test('signals are routed by their declared kind', () => {
  const { contradictions, risks } = partitionSignalsByKind([
    { rule: 'TYPE_CONFLICT', kind: 'contradiction' },
    { rule: 'PREDICATE_DRIFT', kind: 'risk' },
    // Pre-`kind` signals stay contradictions: every rule in
    // lib/contradiction-rules.js sets the field, so a missing one is legacy.
    { rule: 'LEGACY_RULE' },
    null,
  ]);
  assert.deepStrictEqual(contradictions.map(s => s.rule), ['TYPE_CONFLICT', 'LEGACY_RULE']);
  assert.deepStrictEqual(risks.map(s => s.rule), ['PREDICATE_DRIFT']);
});

test('an evidence-free contradiction borrows its signals evidence when it has any', () => {
  const guarded = enforceEvidencedContradiction(
    { status: 'contradicted', confidence: 0.9 },
    [],
    {
      signals: [{
        rule: 'TYPE_CONFLICT',
        kind: 'contradiction',
        confidence: 0.9,
        detail: 'type conflict',
        evidence: [{ text: 'kedi tür hayvan', role: 'stored' }],
      }],
    },
  );
  assert.strictEqual(guarded.data.status, 'contradicted');
  assert.strictEqual(guarded.evidence.length, 1);
  assert.match(guarded.evidence[0].text, /kedi tür hayvan/);
});

test('a contradiction with no derivable evidence is downgraded to unknown', () => {
  const guarded = enforceEvidencedContradiction(
    { status: 'contradicted', confidence: 0.6 },
    [],
    { signals: [{ rule: 'PREDICATE_DRIFT', kind: 'risk', confidence: 0.6, detail: 'drift' }] },
  );
  assert.strictEqual(guarded.data.status, 'unknown');
  assert.strictEqual(guarded.data.confidence, 0);
  assert.deepStrictEqual(guarded.evidence, []);
});

test('verified and unknown verdicts pass through untouched', () => {
  for (const status of ['verified', 'unknown']) {
    const data = { status, confidence: 0.8 };
    const guarded = enforceEvidencedContradiction(data, [], { signals: [] });
    assert.strictEqual(guarded.data, data);
    assert.deepStrictEqual(guarded.evidence, []);
  }
});
