'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const Kernel = require('../kernel');
const { FractalLearn } = require('../lib/fractal-learn');
const { runSelfEvolveAdapter } = require('../lib/self-evolve-adapter');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('self_evolve_adapter_test_seed');

function fresh() {
  const k = new Kernel({ noLoad: true });
  const learn = k.learn.bind(k);
  k.learn = (text, learnOpts = {}) => learn(text, { ...learnOpts, ...TEST_FIXTURE_LEARN_BYPASS });
  return k;
}

function seeded() {
  const k = fresh();
  k.learn('kedi memelidir');
  k.learn('köpek memelidir');
  k.learn('memeli hayvandır');
  k.learn('hayvan canlıdır');
  return k;
}

describe('self-evolve-adapter — L4 fractal-learn entegrasyonu', () => {
  it('geçersiz kernel fail-closed reddedilir', () => {
    assert.throws(() => runSelfEvolveAdapter(null, {}), /requires a kernel/);
    assert.throws(() => runSelfEvolveAdapter({}, {}), /requires a kernel/);
  });

  it('gerçek kernel ile çalışır ve iki sonucu birleştirir', () => {
    const k = seeded();
    const r = runSelfEvolveAdapter(k, { workspaceId: 'default', maxRounds: 2, minScore: 0.1 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.type, 'fractal_learn_with_self_evolve');
    // FractalLearn.run'un gerçek sözleşmesi: rounds + totals (hypotheses alanı YOK).
    assert.ok(Array.isArray(r.data.fractalLearn.rounds), 'fractalLearn.rounds dizisi olmalı');
    assert.ok(r.data.fractalLearn.totals, 'fractalLearn.totals olmalı');
    // Self-evolve probe ölçümü dönmeli.
    assert.ok(r.data.selfEvolve.verdict, 'selfEvolve.verdict olmalı');
    assert.ok(r.data.selfEvolve.measurement, 'selfEvolve.measurement olmalı');
  });

  it('FractalLearn DI ile enjekte edilebilir', () => {
    const k = seeded();
    const fl = new FractalLearn(k);
    const r = runSelfEvolveAdapter(k, { workspaceId: 'default', maxRounds: 1, fractalLearn: fl });
    assert.ok(r.data.fractalLearn && r.data.fractalLearn.rounds);
  });

  it('boş grafta hata vermeden temiz sonuç döner', () => {
    const k = fresh();
    const r = runSelfEvolveAdapter(k, { workspaceId: 'default', maxRounds: 2 });
    assert.strictEqual(r.ok, true);
    assert.ok(Array.isArray(r.data.fractalLearn.rounds));
    assert.strictEqual(r.data.fractalLearn.stopReason, 'exhausted');
  });

  it('parametreler geri yansır ve kırpılır', () => {
    const k = fresh();
    const r = runSelfEvolveAdapter(k, { workspaceId: 'w1', maxRounds: 999, depth: 999, minScore: 5 });
    assert.strictEqual(r.data.workspaceId, 'w1');
    assert.ok(r.data.params.maxRounds <= 20);
    assert.ok(r.data.params.depth <= 5);
    assert.ok(r.data.params.minScore <= 1);
    assert.strictEqual(r.data.params.autoTune, false);
  });
});
