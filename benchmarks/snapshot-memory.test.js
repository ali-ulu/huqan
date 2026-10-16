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
const { WARMUP_ITERATIONS } = require('./bench-memory-scale');

describe('snapshot-memory (PR-S4B)', () => {
  it('buildSnapshot returns the documented schema + fields', () => {
    const snap = buildSnapshot({
      iterations: 1,
      fixtures: [{ name: 'tiny-memory', size: 3 }],
      sqliteFixtures: [{ name: 'tiny-sqlite', size: 3 }],
    });
    assert.strictEqual(snap.schema, SCHEMA);
    assert.strictEqual(snap.schema, 'axiom-memory-snapshot');
    assert.strictEqual(snap.version, VERSION);
    assert.strictEqual(typeof snap.generatedAt, 'string');
    assert.ok(snap.generatedAt.endsWith('Z') || /T.*Z$/.test(snap.generatedAt),
      'generatedAt should be an ISO 8601 UTC timestamp');
    assert.strictEqual(typeof snap.commit, 'string');
    assert.strictEqual(snap.iterations, 1);
    assert.strictEqual(snap.warmupIterations, WARMUP_ITERATIONS);
    assert.strictEqual(typeof snap.seed, 'number');
    assert.strictEqual(typeof snap.fixtures, 'object');
    assert.strictEqual(typeof snap.sqliteFixtures, 'object');
  });

  it('snapshot embeds the same contract for memory and SQLite fixtures', () => {
    const snap = buildSnapshot({
      iterations: 1,
      fixtures: [{ name: 'tiny-memory', size: 3 }],
      sqliteFixtures: [{ name: 'tiny-sqlite', size: 3 }],
    });
    for (const [groupName, fixtures] of Object.entries({
      memory: snap.fixtures,
      sqlite: snap.sqliteFixtures,
    })) {
      for (const [name, data] of Object.entries(fixtures)) {
        assert.strictEqual(typeof data.size, 'number');
        assert.strictEqual(typeof data.recordCount, 'number');
        assert.strictEqual(data.recordCount, data.size,
          `${groupName} fixture ${name} must round-trip the full record set`);
        assert.strictEqual(data.useSQLite, groupName === 'sqlite');
        assert.strictEqual(typeof data.ingestMs, 'number');
        assert.strictEqual(typeof data.queryMs, 'number');
        assert.strictEqual(typeof data.roundtripMs, 'number');
      }
    }
  });

  it('two snapshots with the same seed share fixture contents', () => {
    const options = {
      iterations: 1,
      seed: 0xDEADBEEF,
      fixtures: [{ name: 'tiny-memory', size: 3 }],
      sqliteFixtures: [{ name: 'tiny-sqlite', size: 3 }],
    };
    const a = buildSnapshot(options);
    const b = buildSnapshot(options);
    // Timing metrics are non-deterministic, but the fixture shape and
    // recordCount must be identical for a fixed seed.
    for (const groupName of ['fixtures', 'sqliteFixtures']) {
      for (const name of Object.keys(a[groupName])) {
        assert.strictEqual(a[groupName][name].size, b[groupName][name].size);
        assert.strictEqual(a[groupName][name].recordCount, b[groupName][name].recordCount);
      }
    }
  });

  it('getCommit returns a non-empty string', () => {
    const c = getCommit();
    assert.strictEqual(typeof c, 'string');
    assert.ok(c.length > 0);
  });

  it('printHuman produces a multi-line report with all fixture groups', () => {
    const snap = buildSnapshot({
      iterations: 1,
      fixtures: [{ name: 'tiny-memory', size: 3 }],
      sqliteFixtures: [{ name: 'tiny-sqlite', size: 3 }],
    });
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
    assert.ok(captured.includes(`warmupIterations=${WARMUP_ITERATIONS}`),
      'human output must include warmup count');
    assert.ok(captured.includes('[memory:tiny-memory]'));
    assert.ok(captured.includes('[sqlite:tiny-sqlite]'));
  });
});
