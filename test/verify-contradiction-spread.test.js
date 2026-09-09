'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Kernel = require('../kernel');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

function fresh() {
  const iso = path.join(os.tmpdir(), `huqan-h20-${process.pid}-${crypto.randomUUID()}`);
  const k = new Kernel({ noLoad: true, memoryPath: iso });
  const learn = k.learn.bind(k);
  k.learn = (text, learnOpts = {}) => learn(text, { ...learnOpts, ...TEST_FIXTURE_LEARN_BYPASS });
  return k;
}

describe('single contradiction no longer spreads to unrelated claims (#1988)', () => {
  // NOTE: the learned node id is normalized by ingest ('kiracı' -> 'kiraç'),
  // so the stub echoes the subject it is called with instead of hardcoding.
  it("untaught 'kiracı mavi giyer' is unknown despite a contradiction on kiracı", () => {
    const k = fresh();
    k.learn('kiracı ev sahibidir');
    k.detectContradictions = (subj) => [{
      type: 'çoklu-tür',
      node: subj,
      targets: ['ev sahibi', 'misafir'],
      confidence: 0.9,
      edges: [],
      message: 'disjoint types: ev sahibi, misafir',
    }];
    const result = k.verify('kiracı mavi giyer');
    assert.notEqual(result.data.status, 'contradicted');
    assert.equal(result.data.status, 'unknown');
  });

  it('a claim touching the contradiction targets still contradicts', () => {
    const k = fresh();
    k.learn('kiracı ev sahibidir');
    k.detectContradictions = (subj) => [{
      type: 'çoklu-tür',
      node: subj,
      targets: ['ev sahibi', 'misafir'],
      confidence: 0.9,
      edges: [],
      message: 'disjoint types: ev sahibi, misafir',
    }];
    const result = k.verify('kiracı misafirdir');
    assert.equal(result.data.status, 'contradicted');
  });
});
