'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runDream } = require('../lib/kernel-dream');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-dream.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Kernel`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('KERNEL: dream is a one-line delegate', () => {
  assert.equal(
    methodBody(kernelSource, 'dream'),
    'return runDream(opts, { createDreams: dreamOpts => new Dream(this).dream(dreamOpts), graph: this.graph, commitBackgroundEdge: (from, to, relation, source, commitOpts) => this._commitBackgroundEdge(from, to, relation, source, commitOpts), getDreamCount: () => this._dreamCount, setDreamCount: value => { this._dreamCount = value; }, ok: (type, data, evidence) => this._ok(type, data, evidence) });',
  );
});

test('KERNEL: dream delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /kernel\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/kernel["']\)/);
  assert.doesNotMatch(delegateSource, /this\._|this\.graph|this\.\_dreamCount/);
  assert.match(delegateSource, /commitBackgroundEdge/);
  assert.match(delegateSource, /admission/);
});

test('KERNEL: dream preserves hypothesis evidence and counter envelope', () => {
  const calls = [];
  const result = runDream(
    { mode: 'test' },
    {
      createDreams: opts => {
        assert.deepEqual(opts, { mode: 'test' });
        return [{ from: 'kedi', to: 'hayvan', confidence: 0.7, relation: 'tür' }];
      },
      graph: {
        hasAnyEdge: () => false,
        getNode: () => ({ id: 'node' }),
      },
      commitBackgroundEdge: () => ({ decision: 'review' }),
      getDreamCount: () => undefined,
      setDreamCount: value => calls.push(['count', value]),
      ok: (type, data, evidence) => ({ type, data, evidence }),
    },
  );

  assert.equal(result.type, 'dream');
  assert.equal(result.data.cycle, 1);
  assert.deepEqual(calls, [['count', 1]]);
  assert.deepEqual(result.data.learned, []);
  assert.deepEqual(result.data.pending, []);
  assert.deepEqual(result.evidence[0], {
    kind: 'hypothesis',
    text: 'kedi ? hayvan',
    confidence: 0.7,
    nodes: ['kedi', 'hayvan'],
    edges: [{ from: 'kedi', to: 'hayvan', relation: 'tür' }],
  });
});

test('KERNEL: dream preserves admission-routed learned and pending hypotheses', () => {
  const commits = [];
  const result = runDream(
    { learnFromDream: true, dreamLearnThreshold: 0.1 },
    {
      createDreams: () => [
        { from: 'kedi', to: 'hayvan', confidence: 0.8, relation: 'tür', type: 'direct' },
        { from: 'köpek', to: 'memeli', confidence: 0.4, type: 'zincir' },
        { from: 'az', to: 'atlanacak', confidence: 0.05, relation: 'özellik' },
      ],
      graph: {
        hasAnyEdge: () => false,
        getNode: id => id === 'atlanacak' ? null : { id },
      },
      commitBackgroundEdge: (...args) => {
        commits.push(args);
        return args[0] === 'kedi' ? { decision: 'allow', edge: { id: 1 } } : { decision: 'review' };
      },
      getDreamCount: () => 3,
      setDreamCount: value => { assert.equal(value, 4); },
      ok: (type, data) => ({ type, data }),
    },
  );

  assert.equal(result.type, 'dream');
  assert.equal(result.data.cycle, 4);
  assert.deepEqual(result.data.learned, [{ from: 'kedi', to: 'hayvan', confidence: 0.8, relation: 'tür' }]);
  assert.deepEqual(result.data.pending, [{ from: 'köpek', to: 'memeli', confidence: 0.4, relation: 'benzer', decision: 'review' }]);
  assert.equal(commits.length, 2);
  assert.equal(commits[0][2], 'tür');
  assert.equal(commits[1][2], 'benzer');
  assert.deepEqual(commits[0][4], {
    provenanceExtra: { hypothesisType: 'direct', hypothesisConfidence: 0.8, via: null },
  });
});
