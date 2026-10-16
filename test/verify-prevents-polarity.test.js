'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-prevents-polarity-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

let seq = 0;
function makeKernel() {
  seq += 1;
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `k${seq}.json`),
  });
}

// Edges go straight into the graph. The subject under test is the verifier's
// polarity handling, so no plugin, ingest or admission path takes part.
function withEdge(kernel, from, to, relation) {
  kernel.graph.addNode(from, from);
  kernel.graph.addNode(to, to);
  kernel.graph.addEdge(from, to, relation, { strength: 0.8, confidence: 0.95, source: 'manual' });
  return kernel;
}

test('a claim that asserts the stored prevention is verified, not contradicted', async () => {
  const kernel = withEdge(makeKernel(), 'exercise', 'heart disease', 'PREVENTS');

  const result = await kernel.verify('Exercise prevents heart disease');

  assert.equal(result.data.status, 'verified');
  assert.ok(result.data.confidence >= 0.9);
  assert.equal(result.evidence[0].kind, 'direct_edge');
});

test('an affirmative claim against a PREVENTS edge still contradicts', async () => {
  // The branch's original purpose, which the fix must not remove: with
  // `smoking PREVENTS health` stored, "Smoking is health" is a contradiction.
  const kernel = withEdge(makeKernel(), 'smoking', 'health', 'PREVENTS');

  const result = await kernel.verify('Smoking is health');

  assert.equal(result.data.status, 'contradicted');
  assert.equal(result.evidence[0].kind, 'contradiction');
});

test('Turkish prevention wording is read as prevention too', async () => {
  const kernel = withEdge(makeKernel(), 'sigara', 'saglik', 'PREVENTS');

  const result = await kernel.verify('Sigara saglik onler');

  assert.equal(result.data.status, 'verified');
});

// All four advertised causal relations must answer the sentence that states
// them the same way. PREVENTS was the one that inverted.
for (const [statement, subject, object, relation] of [
  ['Smoking causes lung cancer', 'smoking', 'lung cancer', 'CAUSES'],
  ['Exercise prevents heart disease', 'exercise', 'heart disease', 'PREVENTS'],
  ['Authentication enables secure access', 'authentication', 'secure access', 'ENABLES'],
  ['Growth depends on investment', 'growth', 'investment', 'DEPENDS_ON'],
]) {
  test(`${relation} verifies the statement that asserts it`, async () => {
    const kernel = withEdge(makeKernel(), subject, object, relation);

    const result = await kernel.verify(statement);

    assert.equal(result.data.status, 'verified', `${relation} should verify "${statement}"`);
  });
}
