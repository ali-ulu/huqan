'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordFitnessEntry, readFitnessHistory } = require('../lib/fitness-history');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-fitness-history-'));
  return path.join(dir, 'memory.json');
}

function sampleReport(score, grade, workspaceId = 'default') {
  return {
    meta: { workspaceId, nodeCount: 10, edgeCount: 8 },
    components: [
      { name: 'evidenceCoverage', value: 0.9 },
      { name: 'connectivity', value: 0.8 },
    ],
    score,
    grade,
  };
}

describe('fitness-history — kalıcı skor geçmişi', () => {
  it('boş geçmiş → boş dizi', () => {
    const p = tempFile();
    assert.deepEqual(readFitnessHistory(p), []);
  });

  it('kayıt + okuma roundtrip (sıra ve içerik korunur)', () => {
    const p = tempFile();
    recordFitnessEntry(p, sampleReport(0.75, 'B'));
    recordFitnessEntry(p, sampleReport(0.9, 'A'));
    const history = readFitnessHistory(p);
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].score, 0.75);
    assert.strictEqual(history[0].grade, 'B');
    assert.strictEqual(history[1].score, 0.9);
    assert.ok(history[0].ts <= history[1].ts, 'zaman damgaları artan olmalı');
    assert.strictEqual(history[0].type, 'fitness');
  });

  it('limit: son N kayıt döner', () => {
    const p = tempFile();
    for (let i = 0; i < 5; i += 1) recordFitnessEntry(p, sampleReport(i / 10, 'C'));
    const history = readFitnessHistory(p, 3);
    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[2].score, 0.4, 'en yeni kayıt en sonda');
  });

  it('bozuk satırlar atlanır, sağlamlar korunur', () => {
    const p = tempFile();
    recordFitnessEntry(p, sampleReport(0.5, 'C'));
    fs.appendFileSync(p, '{bozuk json\n', 'utf8');
    recordFitnessEntry(p, sampleReport(0.6, 'C'));
    const history = readFitnessHistory(p);
    assert.strictEqual(history.length, 2);
  });

  it('score null rapor temiz kaydedilir', () => {
    const p = tempFile();
    recordFitnessEntry(p, sampleReport(null, null));
    const history = readFitnessHistory(p);
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].score, null);
    assert.strictEqual(history[0].grade, null);
  });
});
