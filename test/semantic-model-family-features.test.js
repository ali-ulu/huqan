'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const factories = [
  require('../lib/cognitive-model-local-ssm').createLocalNeuralModel,
  require('../lib/cognitive-model-local-rwkv').createLocalRwkvModel,
  require('../lib/cognitive-model-local-mamba').createLocalMambaModel,
  require('../lib/cognitive-model-local-transformer').createLocalTransformerModel,
];

test('all existing families expose copied Float32 features without changing their B7 proposal', () => {
  for (const create of factories) {
    const model = create({ seed: 3583, reservoir: 8, steps: 4 });
    const sequence = [0.2, -0.4, 0.6, 0.1];
    model.train([{ sequence, label: 1 }, { sequence: sequence.map(x => -x), label: -1 }]);
    const before = model.predict(sequence);
    const encoded = model.encode(sequence);
    assert.ok(encoded instanceof Float32Array);
    assert.equal(encoded.length, 8);
    const expected = Array.from(encoded);
    encoded.fill(99);
    assert.deepEqual(Array.from(model.encode(sequence)), expected);
    assert.deepEqual(model.predict(sequence), before);
    assert.throws(() => model.encode([1]), /exactly 4 steps/);
  }
});

test('Transformer projection reuse preserves the observed pre-optimization Float32 features', () => {
  const model = factories[3]({ seed: 3583, reservoir: 8, steps: 4 });
  assert.deepEqual(Array.from(model.encode([0.2, -0.4, 0.6, 0.1])), [
    0.0025917431339621544, 0.0007898417534306645, 0.0019300562562420964, 0.0009684113319963217,
    -0.0003126836090814322, -0.0002712091081775725, -0.0013132237363606691, 0.0019154449691995978,
  ]);
});
