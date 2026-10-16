'use strict';

// #3909: the weight lookup in `runAlternatives` moved from a per-target
// `edges.find()` scan (O(degree^2)) to a Map built in one pass. The old scan
// carried an optional-chaining branch (`edge?.weight`); the Map version does
// not, so the branch total shrank and the recorded per-file coverage floor
// would regress unless the remaining branches -- the weight fallback and the
// already-used skip -- are exercised.

const assert = require('node:assert/strict');
const test = require('node:test');

const { runAlternatives } = require('../lib/kernel-alternatives');

test('alternatives falls back to 0.5 when an edge carries no weight (#3909)', () => {
  const graph = {
    getNode: (id) => (id === 'subject' ? { id } : null),
    getEdges: (id) => (id === 'subject' ? [{ to: 'unweighted', relation: 'tür' }] : []),
  };
  const result = runAlternatives(
    value => value.trim().toLowerCase(),
    graph,
    (type, data, evidence) => ({ type, data, evidence }),
    ' subject ',
  );

  assert.equal(result.data.paths.length, 1);
  assert.equal(result.data.paths[0].target ?? result.data.paths[0].to, 'unweighted');
  assert.equal(result.data.paths[0].confidence, 0.5);
});

test('alternatives skips a group whose best target is already used (#3909)', () => {
  const graph = {
    getNode: (id) => (id === 'subject' ? { id } : null),
    getEdges: (id) => (id === 'subject'
      ? [
        { to: 'shared', relation: 'tür', weight: 0.9 },
        { to: 'shared', relation: 'yapabilir', weight: 0.8 },
      ]
      : []),
  };
  const result = runAlternatives(
    value => value.trim().toLowerCase(),
    graph,
    (type, data, evidence) => ({ type, data, evidence }),
    ' subject ',
    3,
  );

  // `shared` is the best `tür` target, so the `yapabilir` group's only target is
  // already used and must be skipped rather than pushed twice.
  assert.deepEqual(result.data.paths.map(path => path.type), ['tür']);
});
