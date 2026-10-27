'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { countIndependentSources } = require('../lib/cognition/independent-sources');

const source = (sourceGroup, ...sourceRefs) => ({ sourceGroup, sourceRefs });

test('counts explicit independent sources without mutating evidence', () => {
  const sources = [source('a', 'ref:a'), source('b', 'ref:b'), source('c', 'ref:c')];
  const before = JSON.stringify(sources);
  assert.equal(countIndependentSources(sources), 3);
  assert.equal(countIndependentSources([...sources].reverse()), 3);
  assert.equal(JSON.stringify(sources), before);
  assert.equal(countIndependentSources([]), 0);
  assert.equal(countIndependentSources([source(null, 'ref:a'), source('missing')]), 0);
});

test('shared groups and transitive reference bridges remain one source outside selection', () => {
  const sources = [source('a', 'ref:a'), source('b', 'ref:b'), source('c', 'ref:c')];
  const dependencies = [...sources, source(null, 'ref:a', 'ref:b'), source('bridge', 'ref:b', 'ref:c')];
  assert.equal(countIndependentSources(sources, dependencies), 1);
  assert.equal(countIndependentSources(sources.slice(0, 2), dependencies), 1);
  assert.equal(countIndependentSources([source('same', 'a'), source('same', 'b')]), 1);
  assert.equal(countIndependentSources([source('a', 'one'), source('b', 'one')]), 1);
  assert.equal(countIndependentSources([source('a', 'one'), source('b', 'one')], []), 1);
});

test('rejects malformed source evidence rather than inventing independence', () => {
  for (const sources of [null, {}, [null], [source(' ', 'a')], [source('a', 1)], [{ sourceGroup: 'a' }]]) {
    assert.throws(() => countIndependentSources(sources), TypeError);
  }
  assert.throws(() => countIndependentSources([], null), TypeError);
});
