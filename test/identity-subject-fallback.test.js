'use strict';

/**
 * The identity subject a question falls back to when none can be detected.
 *
 * RFC-001 decision 7 applied to a node id rather than a spelling: a writer
 * emits `huqan`, and a reader still resolves `axiom` when that is what an
 * older graph holds. Without the legacy read, renaming the constant would make
 * an existing install stop answering a question it used to answer.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-identity-subject-'));

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

// `ask` with no detectable subject is the path that reaches the fallback.
const UNDETECTABLE = 'nedir';

test('an empty graph reports the canonical identity subject', async () => {
  const kernel = makeKernel();

  const result = await kernel.ask(UNDETECTABLE);

  assert.equal(result.data.subject, 'huqan');
  assert.equal(result.data.unknown, true);
});

test('a graph taught about the product resolves the canonical node', async () => {
  const kernel = makeKernel();
  kernel.graph.addNode('huqan', 'huqan');

  const result = await kernel.ask(UNDETECTABLE);

  assert.equal(result.data.subject, 'huqan');
});

test('a pre-rename graph still resolves its legacy identity node', async () => {
  // The whole point of the legacy read: this graph was written before the
  // rename and has no `huqan` node at all.
  const kernel = makeKernel();
  kernel.graph.addNode('axiom', 'axiom');

  const result = await kernel.ask(UNDETECTABLE);

  assert.equal(result.data.subject, 'axiom');
});

test('the canonical node wins when a graph carries both', async () => {
  const kernel = makeKernel();
  kernel.graph.addNode('axiom', 'axiom');
  kernel.graph.addNode('huqan', 'huqan');

  const result = await kernel.ask(UNDETECTABLE);

  assert.equal(result.data.subject, 'huqan');
});

test('the identity seed names HUQAN and lives under its canonical filename', () => {
  const seedPath = path.resolve(__dirname, '..', 'docs', 'seed', 'huqan-identity.seed.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  assert.equal(seed.sourceRef, 'docs/seed/huqan-identity.seed.json');
  assert.doesNotMatch(JSON.stringify(seed), /axiom/i);
});
