'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { isNegativeVerbToken, parseSimpleTurkishStatement } = require('../lib/kernel-v2-native');

function makeKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-verify-negative-claims-'));
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
  return { kernel: new KernelV2({ kernel }), dir };
}

function unwrap(result) {
  return result && result.data && typeof result.data === 'object' ? result.data : result;
}

function seedFacts(kernel) {
  kernel.graph.addNode('ali', 'ali');
  kernel.graph.addNode('doktor', 'doktor');
  kernel.graph.addNode('istanbul', 'istanbul');
  kernel.graph.addEdge('ali', 'doktor', 'tür', { confidence: 0.9 });
  kernel.graph.addEdge('ali', 'istanbul', 'yaşar', { confidence: 0.9 });
}

describe('#1169 Turkish negative claim verification', () => {
  it('normalizes Turkish determiners in predicates and recognizes guarded verbal negatives', () => {
    assert.deepEqual(parseSimpleTurkishStatement('Ali bir doktor değil'), {
      subject: 'ali', predicate: 'doktor', isNegated: true,
    });
    assert.deepEqual(parseSimpleTurkishStatement('Ali şu doktor değil'), {
      subject: 'ali', predicate: 'doktor', isNegated: true,
    });
    assert.deepEqual(parseSimpleTurkishStatement('Ali hiç doktor değil'), {
      subject: 'ali', predicate: 'doktor', isNegated: true,
    });

    for (const statement of ['Ali doktor olamaz', 'Ali doktor olmaz', 'Ali İstanbulda yaşamaz']) {
      assert.equal(parseSimpleTurkishStatement(statement).isNegated, true, statement);
    }
    assert.equal(isNegativeVerbToken('namaz'), false);
    assert.equal(isNegativeVerbToken('olmaz'), true);
    assert.equal(isNegativeVerbToken('olamaz'), true);
    assert.equal(isNegativeVerbToken('yaşamaz'), true);
  });

  it('contradicts a directly stored type fact despite Turkish determiners', () => {
    const { kernel, dir } = makeKernel();
    seedFacts(kernel);

    for (const statement of [
      'Ali bir doktor değil',
      'Ali şu doktor değil',
      'Ali o doktor değil',
      'Ali hiç doktor değil',
    ]) {
      const result = unwrap(kernel.verify(statement, { workspaceId: 'default' }));
      assert.equal(result.status, 'contradicted', statement);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never affirms a Turkish verbal negative through fuzzy overlap', () => {
    const { kernel, dir } = makeKernel();
    seedFacts(kernel);

    for (const statement of [
      'Ali İstanbulda yaşamaz',
      'Ali doktor olamaz',
      'Ali doktor olmaz',
      'Ali bir İstanbulda yaşamaz',
    ]) {
      const raw = kernel.verify(statement, { workspaceId: 'default' });
      const result = unwrap(raw);
      assert.notEqual(result.status, 'verified', statement);
      assert.equal(result.status, 'unknown', statement);
      assert.equal(result.confidence, 0, statement);
      assert.equal(raw.meta.negativeClaimGuard, 'fail_closed', statement);
      assert.deepEqual(raw.evidence, [], statement);
      assert.equal(raw.meta.semanticTrust.status, 'unknown', statement);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a positive control verified', () => {
    const { kernel, dir } = makeKernel();
    seedFacts(kernel);
    const result = unwrap(kernel.verify('Ali doktor', { workspaceId: 'default' }));
    assert.equal(result.status, 'verified');
    assert.equal(result.confidence, 0.95);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
