'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');
const createCompanyBrainPlugin = require('../plugins/company-brain').create;
const { withCausalStrength, DEFAULT_CAUSAL_STRENGTH } = require('../lib/causal-edge-strength');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-causal-strength-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

let kernelSeq = 0;
function makeKernel() {
  kernelSeq += 1;
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `k${kernelSeq}.json`),
    capabilities: { companyMode: true, pluginCapabilities: true },
  });
  kernel.usePlugin(createCompanyBrainPlugin());
  return kernel;
}

function edgesOf(kernel) {
  return kernel.graph.getAllEdges().map((edge) => ({
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    strength: edge.strength,
  }));
}

// graph.js::addEdge throws for a causal relation with no strength, and
// ingestManual proposes its endpoint nodes before proposing the edge. Without
// the default, every causal sentence left orphan nodes and no edge, and the
// whole ingest came back ok:false.
for (const [text, relation] of [
  ['Smoking causes lung cancer', 'CAUSES'],
  ['Vaccination prevents disease', 'PREVENTS'],
  ['Authentication enables secure access', 'ENABLES'],
  ['Growth depends on investment', 'DEPENDS_ON'],
]) {
  test(`manual ingest writes a ${relation} edge instead of throwing`, async () => {
    const kernel = makeKernel();

    const result = await kernel.runCapability('companyBrain', {
      action: 'ingestmanual',
      sourceType: 'manual',
      text,
      author: 'unknown',
    });

    assert.equal(result.ok, true, `ingest failed: ${result.error || ''}`);
    assert.equal(result.added, 1);
    assert.equal(result.admission.outcome, 'allow');
    assert.equal(result.admission.graphWrite, true);

    const causal = edgesOf(kernel).filter((edge) => edge.relation === relation);
    assert.equal(causal.length, 1, `expected exactly one ${relation} edge`);
    assert.equal(causal[0].strength, DEFAULT_CAUSAL_STRENGTH);
  });
}

test('a decision ingest with a causal rationale also writes its edge', async () => {
  const kernel = makeKernel();

  const result = await kernel.runCapability('companyBrain', {
    action: 'ingestdecision',
    sourceType: 'decision',
    title: 'Adopt rate limiting',
    rationale: 'Rate limiting prevents abuse',
    decidedBy: 'unknown',
  });

  assert.equal(result.ok, true, `ingest failed: ${result.error || ''}`);
  assert.ok(edgesOf(kernel).length > 0);
});

test('a non-causal relation gains no strength field', () => {
  const options = withCausalStrength('destekler', { confidence: 0.6 });

  assert.equal(options.strength, undefined);
  assert.equal(options.confidence, 0.6);
});

test('an explicit strength is never overwritten, including zero', () => {
  assert.equal(withCausalStrength('PREVENTS', { strength: 0.1 }).strength, 0.1);
  assert.equal(withCausalStrength('PREVENTS', { strength: 0 }).strength, 0);
});

test('the relation list is graph.js own, so the guard cannot drift', () => {
  const { CAUSAL_RELATIONS } = require('../graph');

  for (const relation of CAUSAL_RELATIONS) {
    assert.equal(
      withCausalStrength(relation, {}).strength,
      DEFAULT_CAUSAL_STRENGTH,
      `${relation} must receive a default strength`,
    );
  }
});
