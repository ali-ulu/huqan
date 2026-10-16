'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const Kernel = require('./kernel');
const { FractalLearn } = require('./lib/fractal-learn');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('fractal_learn_test_seed');

function fresh() {
  const k = new Kernel({ noLoad: true });
  const learn = k.learn.bind(k);
  k.learn = (text, learnOpts = {}) => learn(text, { ...learnOpts, ...TEST_FIXTURE_LEARN_BYPASS });
  return k;
}

describe('FractalLearn - özyinelemeli bilgi sentezi', () => {
  it('geçersiz kernel reddedilir', () => {
    assert.throws(() => new FractalLearn({}), /requires a kernel/);
    assert.throws(() => new FractalLearn(null), /requires a kernel/);
  });

  it('boş grafta exhausted ile durur, sıfır üretim', () => {
    const k = fresh();
    const fl = new FractalLearn(k);
    const r = fl.run({ maxRounds: 3 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.type, 'fractal_learn');
    assert.strictEqual(r.data.stopReason, 'exhausted');
    assert.strictEqual(r.data.totals.generated, 0);
    assert.strictEqual(r.data.rounds.length, 1);
  });

  it('bilgi varken hipotez üretir ve tur özeti döner', () => {
    const k = fresh();
    k.learn('kedi memelidir');
    k.learn('köpek memelidir');
    k.learn('memeli hayvandır');
    k.learn('hayvan canlıdır');
    k.learn('balık hayvandır');

    const fl = new FractalLearn(k);
    const r = fl.run({ maxRounds: 5, minScore: 0.1 });
    assert.strictEqual(r.ok, true);
    assert.ok(r.data.totals.generated > 0, 'en az bir hipotez üretilmeli');
    assert.ok(['exhausted', 'saturated', 'maxRounds'].includes(r.data.stopReason));
    for (const round of r.data.rounds) {
      assert.strictEqual(typeof round.round, 'number');
      assert.strictEqual(typeof round.generated, 'number');
      assert.strictEqual(typeof round.learned, 'number');
      assert.strictEqual(typeof round.deltaEntropy, 'number');
    }
  });

  it('maxRounds sınırını aşmaz', () => {
    const k = fresh();
    k.learn('a b dir');
    k.learn('b c dir');
    k.learn('c d dir');
    k.learn('d e dir');

    const fl = new FractalLearn(k);
    const r = fl.run({ maxRounds: 2, minScore: 0.1 });
    assert.ok(r.data.rounds.length <= 2);
    if (r.data.stopReason === 'maxRounds') {
      assert.strictEqual(r.data.rounds.length, 2);
    }
  });

  it('çıktı şeması kararlıdır (parametreler geri yansır)', () => {
    const k = fresh();
    k.learn('x y dir');
    k.learn('y z dir');
    const fl = new FractalLearn(k);
    const r = fl.run({ depth: 3, maxRounds: 4, minScore: 0.5, entropyFloor: 0.01, workspaceId: 'w1' });
    assert.strictEqual(r.data.params.depth, 3);
    assert.strictEqual(r.data.params.maxRounds, 4);
    assert.strictEqual(r.data.params.minScore, 0.5);
    assert.strictEqual(r.data.workspaceId, 'w1');
  });

  it('sınır dışı değerler kırpılır', () => {
    const k = fresh();
    k.learn('a b dir');
    const fl = new FractalLearn(k);
    const r = fl.run({ maxRounds: 999, depth: 999, minScore: 5 });
    assert.ok(r.data.params.maxRounds <= 20);
    assert.ok(r.data.params.depth <= 5);
    assert.ok(r.data.params.minScore <= 1);
  });

  it('autoTune=false: thresholdChanges boş, geriye uyumluluk', () => {
    const k = fresh();
    k.learn('a b dir');
    k.learn('b c dir');
    const fl = new FractalLearn(k);
    const r = fl.run({ maxRounds: 2, minScore: 0.1 });
    assert.strictEqual(r.data.params.autoTune, false);
    assert.deepEqual(r.data.thresholdChanges, []);
  });

  it('autoTune=true: çıktıya thresholdChanges alanı eklenir, yetersiz veride değişmez', () => {
    const k = fresh();
    k.learn('a b dir');
    k.learn('b c dir');
    k.learn('c d dir');
    const fl = new FractalLearn(k);
    const r = fl.run({ maxRounds: 3, minScore: 0.1, autoTune: true });
    assert.strictEqual(r.data.params.autoTune, true);
    assert.ok(Array.isArray(r.data.thresholdChanges));
    // candidate_claims boş olduğundan sıkılaştırma sinyali oluşmaz -> eşik değişmez.
    assert.deepEqual(r.data.thresholdChanges, []);
  });
});
