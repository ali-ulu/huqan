'use strict';

/**
 * #1186: the `sayısal` pass evaluated its two guards inside the pair loop, so a
 * node of degree d did d²/2 rounds of string work. Measured on a hub with
 * numeric neighbour labels, detectContradictions() took 12 s at degree 1600 and
 * returned nothing -- every pair failed the 5-character core guard after the
 * string work had already been done.
 *
 * Both guards are per-edge properties, so they are now applied per edge. That
 * is only a speed-up if it decides exactly the same pairs, which is what the
 * equivalence test below checks against the original pairwise algorithm.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { temporalQualifier } = require('../lib/temporal-qualifier');
const { findNumericContradictions } = require('../lib/verify-numeric-contradictions');
const VerifyService = require('../lib/verify');

// A VerifyService is only needed for its two text helpers, which are pure.
const service = new VerifyService({ graph: { getEdges: () => [], getNodes: () => ({}) } });
const text = {
  extractNumbers: value => service._extractNumbers(value),
  getTextCore: value => service._getTextCore(value),
};

/** The pre-#1186 implementation, transcribed, as the equivalence reference. */
function pairwiseReference(edges, nodeId) {
  const edgesWithNums = [];
  for (const e of edges) {
    if (e.relation === 'hipotez') continue;
    const nums = text.extractNumbers(e.to);
    if (nums) edgesWithNums.push({ edge: e, nums });
  }
  const out = [];
  if (edgesWithNums.length < 2) return out;
  for (let i = 0; i < edgesWithNums.length; i++) {
    for (let j = i + 1; j < edgesWithNums.length; j++) {
      if (edgesWithNums[i].nums === edgesWithNums[j].nums) continue;
      if (temporalQualifier(edgesWithNums[i].edge.to) !== temporalQualifier(edgesWithNums[j].edge.to)) continue;
      const normI = text.getTextCore(edgesWithNums[i].edge.to).replace(/\s+/g, ' ');
      const normJ = text.getTextCore(edgesWithNums[j].edge.to).replace(/\s+/g, ' ');
      const shorter = normI.length <= normJ.length ? normI : normJ;
      const longer = normI.length <= normJ.length ? normJ : normI;
      if (shorter.length < 5) continue;
      if (!longer.includes(shorter)) continue;
      out.push({
        type: 'sayısal',
        node: nodeId,
        targets: [edgesWithNums[i].edge.to, edgesWithNums[j].edge.to],
        confidence: 0.75,
        message: 'numeric conflict for ' + nodeId,
        edges: [edgesWithNums[i].edge, edgesWithNums[j].edge],
      });
    }
  }
  return out;
}

const edge = (to, relation = 'olcum') => ({ from: 'hub', to, relation });

describe('#1186 findNumericContradictions matches the pairwise scan it replaced', () => {
  const cases = [
    ['no numbers at all', ['alpha', 'beta', 'gamma']],
    ['short cores only', ['n1', 'n2', 'n3']],
    ['one shared core', ['olcum degeri 10 birim', 'olcum degeri 20 birim']],
    ['same numbers', ['olcum degeri 10 birim', 'olcum degeri 10 birim']],
    ['mixed lengths', ['olcum degeri 10 birim', 'olcum 20', 'olcum degeri 30 birim ek']],
    ['temporal split', ['gelir 2023 100 birim degeri', 'gelir 2024 200 birim degeri', 'gelir 2023 300 birim degeri']],
    ['hypothesis edges excluded', ['olcum degeri 10 birim', 'olcum degeri 20 birim']],
    ['unrelated cores', ['agirlik degeri 10 kg', 'hiz degeri 20 kmh']],
    ['single edge', ['olcum degeri 10 birim']],
    ['empty', []],
  ];

  for (const [name, targets] of cases) {
    it(name, () => {
      const edges = targets.map((target, index) => (
        name === 'hypothesis edges excluded' && index === 1 ? edge(target, 'hipotez') : edge(target)
      ));
      assert.deepStrictEqual(
        findNumericContradictions(edges, 'hub', text),
        pairwiseReference(edges, 'hub'),
        name,
      );
    });
  }

  it('agrees on randomized label mixes, order included', () => {
    // Deterministic pseudo-random so a failure is reproducible.
    let seed = 20260825;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pieces = ['olcum', 'degeri', 'birim', 'gelir', 'kg', 'n', 'v2.1', '2023', '2024', 'ek'];

    for (let round = 0; round < 40; round += 1) {
      const edges = [];
      const count = 2 + Math.floor(next() * 10);
      for (let i = 0; i < count; i += 1) {
        const words = [];
        const length = 1 + Math.floor(next() * 4);
        for (let w = 0; w < length; w += 1) words.push(pieces[Math.floor(next() * pieces.length)]);
        if (next() < 0.8) words.splice(Math.floor(next() * (words.length + 1)), 0, String(Math.floor(next() * 50)));
        edges.push(edge(words.join(' '), next() < 0.1 ? 'hipotez' : 'olcum'));
      }
      assert.deepStrictEqual(
        findNumericContradictions(edges, 'hub', text),
        pairwiseReference(edges, 'hub'),
        `round ${round}: ${JSON.stringify(edges.map(e => e.to))}`,
      );
    }
  });

  it('an edge whose own core is too short cannot pair with anything', () => {
    // The guard is `shorter.length < 5`, so a short core disqualifies the edge
    // itself -- this is what lets it be dropped before the loop.
    const edges = [edge('n 1'), edge('olcum degeri 20 birim'), edge('olcum degeri 30 birim')];
    const found = findNumericContradictions(edges, 'hub', text);

    assert.deepStrictEqual(found, pairwiseReference(edges, 'hub'));
    for (const item of found) {
      assert.ok(!item.targets.includes('n 1'), 'the short-core edge must not appear in any pair');
    }
  });
});

describe('#1186 the wasted-work case is no longer quadratic', () => {
  it('a hub of numeric labels that can never match is linear-ish, not quadratic', () => {
    const build = (degree) => Array.from({ length: degree }, (_, i) => edge('n' + i));
    const time = (edges) => {
      const started = process.hrtime.bigint();
      const found = findNumericContradictions(edges, 'hub', text);
      return { ms: Number(process.hrtime.bigint() - started) / 1e6, found };
    };

    time(build(200)); // warm up
    const small = time(build(400));
    const large = time(build(1600));

    assert.equal(small.found.length, 0, 'these labels share no text core');
    assert.equal(large.found.length, 0);

    // Quadratic would be ~16x for a 4x degree increase, and the pre-fix
    // measurement was exactly that. A generous ceiling still fails loudly if
    // the per-pair string work comes back, without being timing-flaky.
    const growth = large.ms / Math.max(small.ms, 0.05);
    assert.ok(growth < 12, `degree 400 -> 1600 grew ${growth.toFixed(1)}x, expected well under quadratic`);
  });
});
