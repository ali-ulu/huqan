'use strict';

/**
 * Turkish prose must not ride on the English API surfaces.
 *
 * The verify-status *vocabulary* was migrated separately (see
 * docs/verify-status-vocabulary-migration.md). This covers the free prose that
 * travelled next to it: evidence sentences built in lib/verify.js, and the MCP
 * tool descriptions every Claude and Cursor user reads in tools/list.
 *
 * Scope is deliberately the emitted surface, not the repository. Turkish
 * command words in lib/command-parser.js, the linguistic data in
 * lib/contradiction-rules.js and lib/type-lattice.js, and the legacy statuses
 * in lib/verify-status-vocabulary.js are all inputs the reader accepts on
 * purpose, per RFC-001 decision 7. They are not what a caller is answered with.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');
const { TOOL_SCHEMAS } = require('../lib/mcp-tool-catalog');

const TURKISH_LETTER = /[çğışöüÇĞİŞÖÜ]/;
// U+FFFD. Three of these strings shipped with their Turkish characters already
// destroyed, so a caller read "Say?sal kar??la?t?rma" -- broken twice over.
const REPLACEMENT_CHAR = /�/;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-english-prose-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

let seq = 0;
function makeKernel() {
  seq += 1;
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `k${seq}.json`),
  });
}

function withEdge(kernel, from, to, relation) {
  kernel.graph.addNode(from, from);
  kernel.graph.addNode(to, to);
  kernel.graph.addEdge(from, to, relation, { strength: 0.8, confidence: 0.95, source: 'manual' });
  return kernel;
}

test('advertised MCP tool schemas carry no Turkish text', () => {
  const serialized = JSON.stringify(TOOL_SCHEMAS);

  assert.doesNotMatch(serialized, TURKISH_LETTER);
  assert.doesNotMatch(serialized, REPLACEMENT_CHAR);
  // The worked examples were "kedi hayvandir" and "kedi nedir" on an
  // English-positioned product, in the first thing an MCP client renders.
  assert.doesNotMatch(serialized, /kedi|tavuk|yumurta|hayvandir|bitkidir/);
});

test('contradiction evidence is English', async () => {
  const kernel = withEdge(makeKernel(), 'smoking', 'health', 'PREVENTS');

  const result = await kernel.verify('Smoking is health');

  assert.equal(result.data.status, 'contradicted');
  const text = result.evidence[0].text;
  assert.doesNotMatch(text, TURKISH_LETTER);
  assert.doesNotMatch(text, REPLACEMENT_CHAR);
  assert.match(text, /contradicts/);
});

test('supporting evidence is English', async () => {
  const kernel = withEdge(makeKernel(), 'smoking', 'lung cancer', 'CAUSES');

  const result = await kernel.verify('Smoking causes lung cancer');

  assert.equal(result.data.status, 'verified');
  for (const item of result.evidence) {
    assert.doesNotMatch(item.text, TURKISH_LETTER);
    assert.doesNotMatch(item.text, REPLACEMENT_CHAR);
  }
});

test('lib/verify.js emits no replacement characters at all', () => {
  // A guard on the source, not a rendered string: the three corrupted literals
  // were only reachable through numeric-comparison branches that no test drove,
  // so they survived every green run.
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify.js'), 'utf8');

  assert.doesNotMatch(source, REPLACEMENT_CHAR);
});
