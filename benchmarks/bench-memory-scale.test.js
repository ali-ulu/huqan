'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  makeRng,
  generateMemoryRecord,
  generateFixture,
  benchSize,
  runBenchmarks,
  DEFAULT_SEED,
  DEFAULT_FIXTURES,
} = require('./bench-memory-scale');

describe('bench-memory-scale (PR-S4B)', () => {
  describe('deterministic fixture generation', () => {
    it('same seed produces the same fixture', () => {
      const a = generateFixture(50, 0xC0FFEE, 'ws-a');
      const b = generateFixture(50, 0xC0FFEE, 'ws-a');
      assert.strictEqual(a.length, 50);
      assert.strictEqual(b.length, 50);
      assert.deepStrictEqual(a, b,
        'same seed must produce byte-identical fixtures');
    });

    it('different seeds produce different fixtures', () => {
      const a = generateFixture(10, 1, 'ws-a');
      const b = generateFixture(10, 2, 'ws-a');
      assert.notDeepStrictEqual(a, b,
        'different seeds must produce different fixtures');
    });

    it('workspaceId is honored on every record', () => {
      const a = generateFixture(5, 7, 'ws-alpha');
      for (const r of a) {
        assert.strictEqual(r.workspaceId, 'ws-alpha');
      }
    });

    it('makeRng returns deterministic sequence', () => {
      const r1 = makeRng(42);
      const r2 = makeRng(42);
      for (let i = 0; i < 100; i++) {
        assert.strictEqual(r1(), r2(),
          `mismatch at sample ${i}`);
      }
    });
  });

  describe('generateMemoryRecord shape', () => {
    it('records carry content + metadata + actor + trustPolicyVersion', () => {
      const rng = makeRng(0xBEEF);
      const rec = generateMemoryRecord(0, rng, 'ws-x');
      assert.strictEqual(typeof rec.content, 'string');
      assert.ok(rec.content.length > 0);
      assert.strictEqual(typeof rec.metadata, 'object');
      assert.ok(['A', 'B'].includes(rec.metadata.tag));
      assert.ok(['alice', 'bob'].includes(rec.actor));
      assert.strictEqual(rec.trustPolicyVersion, '1.0.0');
    });
  });

  describe('benchSize smoke', () => {
    it('runs ingest/query/roundtrip and reports recordCount', () => {
      const out = benchSize('smoke', 10, { iterations: 1, seed: 0xCAFE });
      assert.strictEqual(out.name, 'smoke');
      assert.strictEqual(out.size, 10);
      assert.strictEqual(out.iterations, 1);
      assert.strictEqual(out.seed, 0xCAFE);
      assert.strictEqual(out.recordCount, 10);
      assert.strictEqual(typeof out.ingestMs, 'number');
      assert.strictEqual(typeof out.queryMs, 'number');
      assert.strictEqual(typeof out.roundtripMs, 'number');
      assert.ok(Number.isFinite(out.ingestMs));
      assert.ok(Number.isFinite(out.queryMs));
      assert.ok(Number.isFinite(out.roundtripMs));
    });
  });

  describe('runBenchmarks smoke', () => {
    it('produces the default fixture set', () => {
      const out = runBenchmarks({ iterations: 1 });
      assert.strictEqual(out.version, '1.0.0');
      assert.strictEqual(out.iterations, 1);
      assert.strictEqual(out.seed, DEFAULT_SEED);
      for (const f of DEFAULT_FIXTURES) {
        assert.ok(out.fixtures[f.name],
          `expected fixture ${f.name} in output`);
        assert.strictEqual(out.fixtures[f.name].size, f.size);
      }
    });

    it('honors a custom fixtures list', () => {
      const out = runBenchmarks({
        iterations: 1,
        fixtures: [{ name: 'tiny', size: 3 }],
      });
      assert.ok(out.fixtures.tiny);
      assert.strictEqual(out.fixtures.tiny.size, 3);
      assert.strictEqual(out.fixtures.tiny.recordCount, 3);
      assert.strictEqual(out.fixtures.small, undefined);
    });
  });
});
