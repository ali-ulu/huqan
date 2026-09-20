'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderMermaid } = require('./architecture-mermaid');

test('renderMermaid emits deterministic layer nodes and aggregated directed edges', () => {
  const graph = new Map([
    ['cli.js', ['lib/domain.js', 'lib/util.js']],
    ['server.js', []],
    ['lib/domain.js', ['server.js']],
    ['lib/storage/store.js', ['lib/domain.js']],
    ['lib/util.js', []],
  ]);

  const output = renderMermaid(graph);
  assert.match(output, /^```mermaid\nflowchart TB/m);
  assert.match(output, /entrypoint\["entrypoint"\]/);
  assert.match(output, /domain\["domain"\]/);
  assert.match(output, /storage\["storage"\]/);
  assert.match(output, /shared\["shared"\]/);
  assert.match(output, /entrypoint -->\|"1"\| domain/);
  assert.match(output, /entrypoint -->\|"1"\| shared/);
  assert.match(output, /storage -->\|"1"\| domain/);
});
