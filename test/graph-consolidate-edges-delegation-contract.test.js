'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'graph-consolidate-edges.js'),
  'utf8',
);

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

function edge(from, to, relation, weight, extra = {}) {
  return { from, to, relation, weight, ...extra };
}

function runDelegate(edges, dryRun, callbacks = {}) {
  const consolidateEdges = require('../lib/graph-consolidate-edges');
  return consolidateEdges({
    edges,
    dryRun,
    replaceEdges: callbacks.replaceEdges || (() => {}),
    rebuildIndex: callbacks.rebuildIndex || (() => {}),
    save: callbacks.save || (() => {}),
    logSaveError: callbacks.logSaveError || (() => {}),
  });
}

test('GRAPH: _consolidateEdges is a one-line injected delegation', () => {
  assert.equal(
    methodBody(graphSource, '_consolidateEdges'),
    "return consolidateEdges({ edges: this._edges, dryRun, replaceEdges: arr => { this._edges = arr; }, rebuildIndex: () => this._rebuildIndex(), save: () => this.save(), logSaveError: error => { console.error('[Kernel] Graph save hatası:', error.message); } });",
  );
});

test('GRAPH: consolidation delegate is narrow, callback-driven, and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(/);
  assert.doesNotMatch(delegateSource, /this\._(?:edges|nodes|db)/);
  assert.doesNotMatch(delegateSource, /class\s+Graph/);
  assert.doesNotMatch(delegateSource, /console\.error/);
  assert.match(delegateSource, /module\.exports = consolidateEdges;/);
});

test('GRAPH: consolidation dry-run preserves input and returns deterministic details', () => {
  const high = edge('subject', 'object', 'kept', 0.9);
  const low = edge('subject', 'object', 'stale', 0.2);
  const originalEdges = [high, low];
  let replaced = false;
  let rebuilt = false;
  let saved = false;

  const result = runDelegate(originalEdges, true, {
    replaceEdges: () => { replaced = true; },
    rebuildIndex: () => { rebuilt = true; },
    save: () => { saved = true; },
  });

  assert.deepStrictEqual(result, {
    dryRun: true,
    removed: 1,
    details: [
      'subject ? object (stale, w:0.2): low-weight (0.2) superseded by high-weight (0.9) for same pair',
    ],
  });
  assert.deepStrictEqual(originalEdges, [high, low]);
  assert.equal(replaced, false);
  assert.equal(rebuilt, false);
  assert.equal(saved, false);
});

test('GRAPH: consolidation apply replaces, rebuilds, and saves in order', () => {
  const high = edge('subject', 'object', 'kept', 0.9);
  const low = edge('subject', 'object', 'stale', 0.2);
  const originalEdges = [high, low];
  const calls = [];
  let replacement;

  const result = runDelegate(originalEdges, false, {
    replaceEdges: edges => {
      calls.push('replace');
      replacement = edges;
    },
    rebuildIndex: () => calls.push('rebuild'),
    save: () => calls.push('save'),
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.removed, 1);
  assert.deepStrictEqual(replacement, [high]);
  assert.notStrictEqual(replacement, originalEdges);
  assert.deepStrictEqual(calls, ['replace', 'rebuild', 'save']);
});

test('GRAPH: consolidation save errors are swallowed and passed to Graph logging callback', () => {
  const high = edge('subject', 'object', 'kept', 0.9);
  const low = edge('subject', 'object', 'stale', 0.2);
  const saveError = new Error('disk full');
  const logged = [];

  assert.doesNotThrow(() => runDelegate([high, low], false, {
    save: () => { throw saveError; },
    logSaveError: error => logged.push(error),
  }));

  assert.deepStrictEqual(logged, [saveError]);
});
