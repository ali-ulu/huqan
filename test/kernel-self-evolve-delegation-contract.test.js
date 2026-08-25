'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runSelfEvolve } = require('../lib/kernel-self-evolve');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-self-evolve.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Kernel`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('KERNEL: selfEvolve is a one-line delegate', () => {
  assert.equal(
    methodBody(kernelSource, 'selfEvolve'),
    'return runSelfEvolve(opts, buildSelfEvolveCollaborators(this, Dream, workspaceIdFrom(opts)));',
  );
});

test('KERNEL: selfEvolve delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /kernel\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/kernel["']\)/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /_nodes|_edges|_db|_stmts/);
  assert.match(delegateSource, /commitBackgroundEdge/);
  assert.match(delegateSource, /consolidate/);
  assert.match(delegateSource, /optimize/);
});

test('KERNEL: selfEvolve preserves relation mapping, deferred admission, and maintenance order', () => {
  const calls = [];
  const result = runSelfEvolve(
    {},
    {
      createDreams: () => [{ from: 'kaynak', to: 'hedef', type: 'vektör-benzerlik', confidence: 0.9 }],
      graph: { getEdge: (...args) => { calls.push(['getEdge', ...args]); return null; } },
      commitBackgroundEdge: (...args) => {
        calls.push(['commit', ...args]);
        return { decision: 'review', edge: null };
      },
      consolidate: dryRun => { calls.push(['consolidate', dryRun]); return { removed: 0 }; },
      optimize: () => { calls.push(['optimize']); return { pruned: 2 }; },
      save: () => { calls.push(['save']); },
      getDreamCount: () => undefined,
      setDreamCount: value => calls.push(['count', value]),
    },
  );

  assert.deepEqual(result, {
    workspaceId: 'default',
    dreams: 1,
    added: 0,
    addedDetails: [],
    deferred: 1,
    deferredDetails: [{ from: 'kaynak', to: 'hedef', relation: 'benzer', confidence: 0.9, type: 'vektör-benzerlik', decision: 'review' }],
    consolidated: 0,
    optimized: 2,
  });
  assert.equal(calls[0][0], 'getEdge');
  assert.equal(calls[0][3], 'benzer');
  assert.equal(calls[0][4], 'default', 'the duplicate check is workspace-scoped (#1189)');
  assert.equal(calls[1][0], 'commit');
  assert.equal(calls[1][2], 'hedef');
  assert.equal(calls[1][3], 'benzer');
  assert.deepEqual(calls[1][5], {
    edgeOptions: { weight: 0.4, source: 'kendilik' },
    provenanceExtra: { hypothesisType: 'vektör-benzerlik', hypothesisConfidence: 0.9, weight: 0.4 },
  });
  assert.deepEqual(calls.slice(2), [['consolidate', false], ['optimize'], ['save'], ['count', 1]]);
});

test('KERNEL: selfEvolve saves optimized pruning even without additions', () => {
  const calls = [];
  const result = runSelfEvolve(
    {},
    {
      createDreams: () => [],
      graph: { getEdge: () => null },
      commitBackgroundEdge: () => ({ decision: 'review', edge: null }),
      consolidate: dryRun => { calls.push(['consolidate', dryRun]); return { removed: 0 }; },
      optimize: () => { calls.push(['optimize']); return { pruned: 2 }; },
      save: () => { calls.push(['save']); },
      getDreamCount: () => 0,
      setDreamCount: value => calls.push(['count', value]),
    },
  );

  assert.deepEqual(result, {
    workspaceId: 'default',
    dreams: 0,
    added: 0,
    addedDetails: [],
    deferred: 0,
    deferredDetails: [],
    consolidated: 0,
    optimized: 2,
  });
  assert.deepEqual(calls, [['consolidate', false], ['optimize'], ['save'], ['count', 1]]);
});

test('KERNEL: selfEvolve preserves allowed writes, save condition, filters, and save-error swallowing', () => {
  const calls = [];
  const logged = [];
  const result = runSelfEvolve(
    { minConfidence: 0.5 },
    {
      createDreams: () => [
        { from: 'a', to: 'b', type: 'zincir', confidence: 0.6 },
        { from: 'skip', to: 'low', type: 'direct', confidence: 0.4 },
      ],
      graph: { getEdge: () => null },
      commitBackgroundEdge: (...args) => {
        calls.push(['commit', ...args]);
        return { decision: 'allow', edge: { id: 'edge-1' } };
      },
      consolidate: dryRun => { calls.push(['consolidate', dryRun]); return { removed: 1 }; },
      optimize: () => { calls.push(['optimize']); return { pruned: 3 }; },
      save: () => { calls.push(['save']); throw new Error('save unavailable'); },
      getDreamCount: () => 4,
      setDreamCount: value => calls.push(['count', value]),
      logSaveError: error => logged.push(error.message),
    },
  );

  assert.equal(result.dreams, 2);
  assert.equal(result.added, 1);
  assert.equal(result.deferred, 0);
  assert.deepEqual(result.addedDetails, [{ from: 'a', to: 'b', relation: 'hipotez', confidence: 0.6, type: 'zincir' }]);
  assert.equal(result.consolidated, 1);
  assert.equal(result.optimized, 3);
  assert.deepEqual(calls.slice(-3), [['optimize'], ['save'], ['count', 5]]);
  assert.deepEqual(logged, ['save unavailable']);
});
