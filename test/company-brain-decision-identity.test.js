'use strict';

/**
 * Decision-log identity must survive long titles and Turkish orthography.
 *
 * Node ids were built from `slug(title)`, which truncates at 48 characters, so
 * two decisions on the same date whose titles diverged after character 48
 * collapsed onto one node -- silently, both calls returning ok:true. Two
 * contradictory retention policies then stood as evidence for the same
 * decision, and contradiction detection could not see a conflict, because the
 * graph held only one decision.
 *
 * Separately, `.toLowerCase()` maps `İ` (U+0130) to `i` + U+0307; the combining
 * dot fell outside the allowed character class and became a separator, so every
 * `İ` split its word in two.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const companyBrain = require('../plugins/company-brain');

function makeKernel() {
  const nodes = new Set();
  const edges = [];
  return {
    nodes,
    edges,
    proposeNode: (id) => { nodes.add(id); return { decision: 'allow', node: { id } }; },
    proposeEdge: (from, to, relation, opts) => {
      edges.push({ from, to, relation, evidence: opts?.evidence || [] });
      return { decision: 'allow', edge: { from, to, relation } };
    },
    graph: { getStats: () => ({ nodes: nodes.size, edges: edges.length }) },
  };
}

const LONG_A = 'Musteri veri saklama politikasini degistirme karari - AB pazari icin';
const LONG_B = 'Musteri veri saklama politikasini degistirme karari - ABD pazari icin';

test('two decisions differing only after the 48th character stay separate', () => {
  const kernel = makeKernel();

  const first = companyBrain._test.ingestDecision(kernel, {
    title: LONG_A, rationale: 'AB GDPR uyumu icin 90 gun', date: '2026-08-23', decidedBy: 'ali',
  });
  const second = companyBrain._test.ingestDecision(kernel, {
    title: LONG_B, rationale: 'ABD icin 7 yil saklama zorunlulugu', date: '2026-08-23', decidedBy: 'ali',
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const decisionNodes = [...kernel.nodes].filter((id) => id.startsWith('decision:'));
  const rationaleNodes = [...kernel.nodes].filter((id) => id.startsWith('decision-rationale:'));
  assert.equal(decisionNodes.length, 2, 'two decisions must occupy two nodes');
  assert.equal(rationaleNodes.length, 2, 'their rationales must not share a node either');
});

test('each rationale hangs off its own decision', () => {
  const kernel = makeKernel();
  companyBrain._test.ingestDecision(kernel, {
    title: LONG_A, rationale: 'AB GDPR uyumu icin 90 gun', date: '2026-08-23', decidedBy: 'ali',
  });
  companyBrain._test.ingestDecision(kernel, {
    title: LONG_B, rationale: 'ABD icin 7 yil saklama zorunlulugu', date: '2026-08-23', decidedBy: 'ali',
  });

  const explains = kernel.edges.filter((edge) => edge.relation === 'açıklar');
  assert.equal(explains.length, 2);
  assert.notEqual(explains[0].from, explains[1].from, 'contradictory policies must not be evidence for one decision');
});

test('the same decision ingested twice is still one node', () => {
  const kernel = makeKernel();
  const input = { title: LONG_A, rationale: 'AB GDPR uyumu icin 90 gun', date: '2026-08-23', decidedBy: 'ali' };

  companyBrain._test.ingestDecision(kernel, input);
  companyBrain._test.ingestDecision(kernel, { ...input });

  assert.equal([...kernel.nodes].filter((id) => id.startsWith('decision:')).length, 1, 'identity must stay stable for identical input');
});

test('a Turkish İ does not split the readable part of the id', () => {
  const kernel = makeKernel();

  companyBrain._test.ingestDecision(kernel, {
    title: 'ÜRÜN İADE POLİTİKASI', rationale: 'iade suresi 14 gun', date: '2026-08-23', decidedBy: 'ali',
  });

  const [decisionNode] = [...kernel.nodes].filter((id) => id.startsWith('decision:'));
  assert.ok(decisionNode, 'a decision node was created');
  assert.match(decisionNode, /ürün-iade-politikası/, `İ must not break words, got ${decisionNode}`);
  assert.doesNotMatch(decisionNode, /i-ade|poli-ti/, 'no word may be split at a combining dot');
});

test('two same-day notes by one author that begin alike stay separate', () => {
  const kernel = makeKernel();
  const shared = 'Toplantida karar alindi ve ';

  companyBrain._test.ingestManual(kernel, { text: `${shared}butce onaylandi`, author: 'ali', date: '2026-08-23' });
  companyBrain._test.ingestManual(kernel, { text: `${shared}butce reddedildi`, author: 'ali', date: '2026-08-23' });

  const notes = [...kernel.nodes].filter((id) => id.startsWith('manual-note:'));
  assert.equal(notes.length, 2, 'the whole note text decides identity, not its first 24 characters');
});

test('an identical note ingested twice is still one node', () => {
  const kernel = makeKernel();
  const input = { text: 'Butce onaylandi', author: 'ali', date: '2026-08-23' };

  companyBrain._test.ingestManual(kernel, input);
  companyBrain._test.ingestManual(kernel, { ...input });

  assert.equal([...kernel.nodes].filter((id) => id.startsWith('manual-note:')).length, 1);
});
