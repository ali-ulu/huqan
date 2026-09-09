'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Kernel = require('../kernel');
const Dream = require('../dream');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

function fresh() {
  const iso = path.join(os.tmpdir(), `huqan-dream-tel-${process.pid}-${crypto.randomUUID()}`);
  const k = new Kernel({ noLoad: true, memoryPath: iso });
  const learn = k.learn.bind(k);
  k.learn = (text, learnOpts = {}) => learn(text, { ...learnOpts, ...TEST_FIXTURE_LEARN_BYPASS });
  return { k, d: new Dream(k) };
}

describe('dream contradiction detector telemetry (#1986)', () => {
  it('a detector throw leaves skipped telemetry instead of silent hypotheses=0', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.learn('Köpek havlar');
    k.learn('Kedi miyavlar');
    const events = [];
    k.plugins.emit = (event, data) => { events.push([event, data]); };
    k.detectContradictions = () => { throw new Error('detector boom'); };
    assert.equal(d._contradictionSkipped, 0);
    const result = d.dream();
    assert.ok(Array.isArray(result));
    assert.equal(d._contradictionSkipped, 1);
    assert.equal(d._contradictionLastError, 'detector boom');
    const skipped = events.filter(([e]) => e === 'dreamContradictionSkipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0][1].error, 'detector boom');
  });

  it('a genuine empty result leaves no skipped telemetry', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.detectContradictions = () => [];
    d.dream();
    assert.equal(d._contradictionSkipped, 0);
    assert.equal(d._contradictionLastError, null);
  });
});
