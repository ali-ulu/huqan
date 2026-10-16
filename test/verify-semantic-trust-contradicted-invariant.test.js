'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Kernel = require('../kernel');

// #2117 removed a KernelV2 branch that rewrote a v1 `contradicted` into
// `unknown` when every semantic signal was a type-relation PREDICATE_DRIFT.
// That branch was unreachable because of the invariant pinned here: since
// #1619, PREDICATE_DRIFT is routed as a risk, so v1 never answers
// `contradicted` on drift alone. If this goes red, the removed branch's
// question has to be answered again rather than silently re-opened.

function withSeededKernel(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2117-invariant-'));
  try {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'memory.json') });
    for (const node of ['kedi', 'hayvan', 'süt']) kernel.graph.addNode(node);
    kernel.graph.addEdge('kedi', 'hayvan', 'tür', { weight: 0.9 });
    kernel.graph.addEdge('kedi', 'süt', 'içer', { weight: 0.9 });
    run(kernel);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rulesOf = result => (result.meta?.semanticTrust?.signals || []).map(signal => signal?.rule);

test('the fixture really produces drift, and drift alone does not refute', () => {
  withSeededKernel((kernel) => {
    const result = kernel.verify('kedi su içer');
    assert.ok(rulesOf(result).includes('PREDICATE_DRIFT'), `no drift signal: ${JSON.stringify(rulesOf(result))}`);
    assert.notEqual(result.data.status, 'contradicted');
    assert.notEqual(result.meta.semanticTrust.status, 'contradicted');
  });
});

test('v1 never answers contradicted with PREDICATE_DRIFT as its only signal', () => {
  withSeededKernel((kernel) => {
    for (const claim of ['kedi su içer', 'kedi kahve içer', 'kedi bir bitkidir', 'kedi hayvan kullanir', 'kedi süt sever']) {
      const result = kernel.verify(claim);
      if (result.data.status !== 'contradicted') continue;
      const rules = rulesOf(result);
      assert.ok(
        rules.some(rule => rule !== 'PREDICATE_DRIFT'),
        `"${claim}" is contradicted on drift alone: ${JSON.stringify(rules)}`,
      );
    }
  });
});
