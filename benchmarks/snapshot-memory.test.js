'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA,
  buildSnapshot,
  printHuman,
  getCommit,
  VERSION,
} = require('./snapshot-memory');

describe('snapshot-memory (PR-S4B)', () => {
  it('buildSnapshot returns the documented schema + fields', () => {
    const snap = buildSnapshot({ iterations: 1 });
    assert.strictEqual(snap.schema, SCHEMA);
    assert.strictEqual(snap.schema, 'axiom-memory-snapshot');
    assert.strictEqual(snap.version, VERSION);
    assert.strictEqual(typeof snap.generatedAt, 'string');
    assert.ok(snap.generatedAt.endsWith('Z') || /T.*Z$/.test(snap.generatedAt),
      'generatedAt should be an ISO 8601 UTC timestamp');
    assert.strictEqual(typeof snap.commit, 'string');
    assert.strictEqual(snap.iterations, 1);
    assert.strictEqual(typeof snap.seed, 'number');
    assert.strictEqual(typeof snap.fixtures, 'object');
  });

  it('snapshot embeds the same fixtures as runBenchmarks', () => {
    const snap = buildSnapshot({ iterations: 1 });
    for (const [name, data] of Object.entries(snap.fixtures)) {
      assert.strictEqual(typeof data.size, 'number');
      assert.strictEqual(typeof data.recordCount, 'number');
      assert.strictEqual(data.recordCount, data.size,
        `fixture ${name} must round-trip the full record set`);
      assert.strictEqual(typeof data.ingestMs, 'number');
      assert.strictEqual(typeof data.queryMs, 'number');
      assert.strictEqual(typeof data.roundtripMs, 'number');
    }
  });

  it('two snapshots with the same seed share fixture contents', () => {
    const a = buildSnapshot({ iterations: 1, seed: 0xDEADBEEF });
    const b = buildSnapshot({ iterations: 1, seed: 0xDEADBEEF });
    // Timing metrics are non-deterministic, but the fixture shape and
    // recordCount must be identical for a fixed seed.
    for (const name of Object.keys(a.fixtures)) {
      assert.strictEqual(a.fixtures[name].size, b.fixtures[name].size);
      assert.strictEqual(a.fixtures[name].recordCount, b.fixtures[name].recordCount);
    }
  });

  it('getCommit returns a non-empty string', () => {
    const c = getCommit();
    assert.strictEqual(typeof c, 'string');
    assert.ok(c.length > 0);
  });

  it('printHuman produces a multi-line report with all fixtures', () => {
    const snap = buildSnapshot({ iterations: 1 });
    let captured = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured += chunk; return true; };
    try {
      printHuman(snap);
    } finally {
      process.stdout.write = origWrite;
    }
    assert.ok(captured.includes('AXIOM memory snapshot'),
      'human output must include header');
    for (const name of Object.keys(snap.fixtures)) {
      assert.ok(captured.includes(`[${name}]`),
        `human output must include fixture ${name}`);
    }
  });
});
