'use strict';

// #3641: lib/kernel-read-use-cases-analysis.js was once saved in a non-UTF-8
// encoding and its display glyphs became '?'. Pin the exact text a user sees so
// a re-encoding of the file turns red instead of shipping '??' to the CLI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');

const WS = 'workspace-glyphs';

function kernelWithCycle(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-glyphs-'));
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
  t.after(() => {
    kernel.graph.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['a', 'b', 'c']) kernel.graph.addNode(id, id, null, { workspaceId: WS });
  kernel.graph.addEdge('a', 'b', 'causes', { weight: 0.9, workspaceId: WS });
  kernel.graph.addEdge('b', 'a', 'causes', { weight: 0.9, workspaceId: WS });
  kernel.graph.addEdge('b', 'c', 'is_a', { weight: 0.9, workspaceId: WS });
  return kernel;
}

test('reason marks a cycle with a warning sign and arrows', (t) => {
  const answer = kernelWithCycle(t).reason('a', WS).data.answer;
  assert.equal(answer, [
    'a:',
    '  neden olur: b [causes], c [is_a]',
    '  nedeni: b [causes]',
    '  ⚠ döngü tespit edildi: a → b → a',
  ].join('\n'));
});

test('compare opens with a chart banner and joins the connecting path with arrows', (t) => {
  const answer = kernelWithCycle(t).compare('a', 'c', WS).data.answer;
  assert.equal(answer, [
    '\u{1F4CA} a vs c:',
    '  sadece a: b [causes]',
    '  bağlantı: a → b → c',
  ].join('\n'));
  assert.doesNotMatch(answer, /\?|�/, 'no glyph was replaced by a placeholder');
});
