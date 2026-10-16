'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { autoTuneThresholds } = require('../lib/fractal-learn-autotune');

const BASE = { minScore: 0.6, entropyFloor: 0.001 };

describe('fractal-learn-autotune — tek yönlü eşik ayarı', () => {
  it('sıkılaştırma sinyali yoksa eşikler değişmez', () => {
    const r = autoTuneThresholds(BASE, { suggestions: [] });
    assert.strictEqual(r.changed, false);
    assert.deepEqual(r.thresholds, BASE);
    assert.deepEqual(r.changes, []);
  });

  it('sıkılaştırma sinyali varsa minScore yükselir, entropyFloor düşer', () => {
    const advice = { suggestions: [{ ruleType: 'ZAYIF_BAĞ', option: 'confidenceFloor', currentValue: 0.5, suggestedValue: 0.45 }] };
    const r = autoTuneThresholds(BASE, advice);
    assert.strictEqual(r.changed, true);
    assert.ok(r.thresholds.minScore > BASE.minScore, 'minScore sıkılaşmalı (yükselmeli)');
    assert.ok(r.thresholds.entropyFloor < BASE.entropyFloor, 'entropyFloor sıkılaşmalı (düşmeli)');
    assert.ok(r.changes.length >= 1);
    assert.ok(r.changes.every((c) => c.direction === 'tighten'));
  });

  it('deterministik: aynı girdi → aynı çıktı', () => {
    const advice = { suggestions: [{ ruleType: 'X', option: 'confidenceFloor' }] };
    const a = autoTuneThresholds(BASE, advice);
    const b = autoTuneThresholds(BASE, advice);
    assert.deepEqual(a, b);
  });

  it('fail-closed: bozuk/eksik advice eşik değiştirmez', () => {
    for (const bad of [null, undefined, {}, { suggestions: null }, { suggestions: 'x' }]) {
      const r = autoTuneThresholds(BASE, bad);
      assert.strictEqual(r.changed, false);
      assert.deepEqual(r.thresholds, BASE);
    }
  });

  it('sınırlara clamp edilir (minScore ≤ 1, entropyFloor ≥ 0)', () => {
    const advice = { suggestions: [{ ruleType: 'X', option: 'confidenceFloor' }] };
    const atMax = autoTuneThresholds({ minScore: 0.99, entropyFloor: 0.0001 }, advice);
    assert.ok(atMax.thresholds.minScore <= 1);
    assert.ok(atMax.thresholds.entropyFloor >= 0);
  });

  it('adım parametreleri özelleştirilebilir', () => {
    const advice = { suggestions: [{ ruleType: 'X' }] };
    const r = autoTuneThresholds({ minScore: 0.5, entropyFloor: 0.01 }, advice, { minScoreStep: 0.1, entropyFloorStep: 0.005 });
    assert.strictEqual(r.thresholds.minScore, 0.6);
    assert.strictEqual(r.thresholds.entropyFloor, 0.005);
  });
});
