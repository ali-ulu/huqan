'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { hasSharedSemanticAnchor, phraseMatches } = require('../lib/verify-native');

function makeKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-verify-anchor-'));
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(dir, 'memory.json'),
    lang: 'tr',
  });
  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  kernel.graph.addNode('ali', 'ali');
  kernel.graph.addNode('doktor', 'doktor');
  kernel.graph.addEdge('ali', 'doktor', 'tür', { confidence: 0.9 });
  return { kernel: new KernelV2({ kernel }), dir };
}

function unwrap(result) {
  return result && result.data && typeof result.data === 'object' ? result.data : result;
}

describe('#1170 semantic anchor boundaries', () => {
  it('accepts exact and bounded Turkish inflection but rejects arbitrary or reversing substrings', () => {
    assert.equal(phraseMatches('doktor', 'doktor'), true);
    assert.equal(phraseMatches('doktor', 'doktorlar'), true);
    assert.equal(phraseMatches('doktorlar', 'doktor'), true);
    assert.equal(phraseMatches('hayvan', 'hayvandır'), true);
    for (const value of [
      'doktorsuz',
      'antidoktor',
      'sahtedoktor',
      'xxdoktoryy',
      'doktorx',
      'doktorumsu',
      'doktorların düşmanı',
    ]) {
      assert.equal(phraseMatches('doktor', value), false, value);
      assert.equal(hasSharedSemanticAnchor('doktor', value), false, value);
    }
  });

  it('does not verify claims merely because a stored target is a substring', () => {
    const { kernel, dir } = makeKernel();
    for (const statement of [
      'Ali bir doktorsuz',
      'Ali bir doktorsuzdur',
      'Ali bir antidoktor',
      'Ali bir sahtedoktor',
      'Ali bir doktorların düşmanı',
      'Ali bir xdoktor',
      'Ali bir xxdoktoryy',
      'Ali bir doktorx',
      'Ali bir doktorumsu',
    ]) {
      const result = unwrap(kernel.verify(statement, { workspaceId: 'default' }));
      assert.notEqual(result.status, 'verified', statement);
      assert.equal(result.status, 'unknown', statement);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps exact and bounded plural support', () => {
    const { kernel, dir } = makeKernel();
    assert.equal(unwrap(kernel.verify('Ali bir doktor', { workspaceId: 'default' })).status, 'verified');
    assert.equal(unwrap(kernel.verify('Ali bir doktorlar', { workspaceId: 'default' })).status, 'verified');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
