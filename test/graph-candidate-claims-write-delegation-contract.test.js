'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegatePath = path.join(__dirname, '..', 'lib', 'graph-candidate-claims-write.js');
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

test('GRAPH: candidate-claim write is delegated to its dedicated module', () => {
  assert.equal(
    methodBody(graphSource, 'addCandidateClaim'),
    'return runCandidateClaimWrite(this._candidateClaimWriteStoreApi(), candidate, opts);',
  );
});

test('GRAPH: candidate-claim write delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_candidateClaims|_stmts|_db/);
  assert.match(delegateSource, /function addCandidateClaim\(storeApi, candidate, opts = \{\}\)/);
});

test('GRAPH: candidate-claim write preserves mutation, persistence and read-back order', () => {
  const { addCandidateClaim } = require('../lib/graph-candidate-claims-write');
  const events = [];
  const stored = [];
  const storeApi = {
    findIndex: () => -1,
    get: index => stored[index],
    replace: (index, value) => {
      events.push('replace');
      stored[index] = value;
    },
    append: value => {
      events.push('append');
      stored.push(value);
    },
    persist: (normalized, workspaceId) => {
      events.push(`persist:${workspaceId}:${normalized.candidateId}`);
    },
    read: filters => {
      events.push(`read:${filters.workspaceId}`);
      return stored;
    },
  };

  const result = addCandidateClaim(storeApi, {
    candidateId: 'candidate-write-contract',
    claim: 'contract claim',
    workspaceId: 'workspace-write-contract',
  }, { workspaceId: 'workspace-write-contract' });

  assert.equal(result.candidateId, 'candidate-write-contract');
  assert.deepEqual(events, [
    'append',
    'persist:workspace-write-contract:candidate-write-contract',
    'read:workspace-write-contract',
  ]);
});
