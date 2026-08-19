'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegatePath = path.join(__dirname, '..', 'lib', 'graph-candidate-claims-read.js');
const delegateSource = fs.readFileSync(delegatePath, 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: candidate-claims read is delegated to its dedicated module', () => {
  assert.equal(
    methodBody(graphSource, 'getCandidateClaims'),
    'return runCandidateClaimsRead(this._candidateClaims, filters);',
  );
});

test('GRAPH: candidate-claims delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.match(delegateSource, /function getCandidateClaims\(candidates, filters = \{\}\)/);
});

test('GRAPH: candidate-claims read preserves workspace fail-closed behavior', () => {
  const { getCandidateClaims } = require('../lib/graph-candidate-claims-read');
  const candidates = [
    { candidateId: 'a', workspaceId: 'alpha', status: 'pending' },
    { candidateId: 'b', workspaceId: 'beta', status: 'pending' },
  ];
  assert.deepEqual(getCandidateClaims(candidates, { workspaceId: '' }), []);
  assert.deepEqual(getCandidateClaims(candidates, { workspaceId: 'alpha' }), [candidates[0]]);
});
