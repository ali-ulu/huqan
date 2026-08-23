'use strict';

/**
 * Issue #327 - the core require graph must stay acyclic.
 *
 * A CommonJS cycle makes whichever module loads second observe a
 * partially-initialized `module.exports` of the first. That surfaces as a
 * silent `undefined` at runtime rather than a load error, which is exactly the
 * class of bug a deterministic reasoning core cannot afford.
 *
 * Four cycles used to run through kernel/graph/conflict-detector/
 * provenance-ingest, all closed by one lazy `require('../kernel')`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  listSourceFiles,
  buildGraph,
  findCycles,
  stripComments,
} = require('../scripts/check-import-cycles');

const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

test('the runtime require graph has no cycles', () => {
  const allFiles = listSourceFiles();
  const sourceFiles = allFiles.filter((file) => !IS_TEST.test(file));
  const cycles = findCycles(buildGraph(allFiles, sourceFiles));

  assert.deepEqual(
    cycles,
    [],
    'require cycles detected:\n  ' + cycles.join('\n  '),
  );
});

test('the cycle checker actually detects a cycle when one exists', () => {
  // Guard against a vacuously passing checker: feed it a known cycle.
  const graph = new Map([
    ['a.js', ['b.js']],
    ['b.js', ['c.js']],
    ['c.js', ['a.js']],
    ['d.js', []],
  ]);

  const cycles = findCycles(graph);
  assert.equal(cycles.length, 1);
  assert.match(cycles[0], /a\.js -> b\.js -> c\.js -> a\.js/);
});

test('stripComments removes line and block comments without touching real require() calls', () => {
  const source = [
    "// a leading comment mentioning require('./ghost')",
    "const b = require('./b'); // trailing comment",
    '/* a block comment',
    " * spanning multiple lines, mentioning require('./also-ghost')",
    ' */',
    "const c = require('./c');",
  ].join('\n');
  const clean = stripComments(source);
  assert.equal(clean.includes('ghost'), false);
  assert.ok(clean.includes("require('./b')"));
  assert.ok(clean.includes("require('./c')"));
});

test('stripComments does not treat "://" inside a string as a comment start', () => {
  const source = "const url = 'https://example.com'; const b = require('./b');";
  const clean = stripComments(source);
  assert.ok(clean.includes('https://example.com'));
  assert.ok(clean.includes("require('./b')"));
});

// buildGraph reads files off disk via fs.readFileSync(path.join(repoRoot,
// file)), so these write real throwaway files under the repo root rather
// than stubbing fs -- mirrors how buildGraph is actually exercised by main().
const repoRoot = path.resolve(__dirname, '..');
function buildGraphFromSources(files, sources) {
  for (const file of files) {
    fs.writeFileSync(path.join(repoRoot, file), sources[file]);
  }
  try {
    return buildGraph(files, files);
  } finally {
    for (const file of files) {
      fs.rmSync(path.join(repoRoot, file), { force: true });
    }
  }
}

test('a require() left only in a comment is not counted as a live edge (#1288)', () => {
  const files = ['tmpcyc-a.js', 'tmpcyc-b.js'];
  const sources = {
    'tmpcyc-a.js': "const b = require('./tmpcyc-b');\nmodule.exports = { b };\n",
    // The cycle back to a.js was actually removed -- only a comment
    // documenting that removal remains, exactly the shape #1288 reports.
    'tmpcyc-b.js': "// Eskiden burada require('./tmpcyc-a') vardi; dongu kirmak icin KALDIRILDI.\nmodule.exports = {};\n",
  };
  const graph = buildGraphFromSources(files, sources);
  assert.deepEqual(findCycles(graph), []);
});

test('a real (non-commented) cycle between two throwaway files is still detected', () => {
  const files = ['tmpcyc-a.js', 'tmpcyc-b.js'];
  const sources = {
    'tmpcyc-a.js': "const b = require('./tmpcyc-b');\nmodule.exports = { b };\n",
    'tmpcyc-b.js': "const a = require('./tmpcyc-a');\nmodule.exports = { a };\n",
  };
  const graph = buildGraphFromSources(files, sources);
  assert.equal(findCycles(graph).length, 1);
});

test('ProvenanceError keeps its identity after moving out of kernel.js', () => {
  const Kernel = require('../kernel');
  const { ProvenanceError } = require('../lib/errors/provenance-error');
  const { buildProvenance } = require('../lib/provenance-ingest');

  // The public facade must keep working for existing callers.
  assert.equal(Kernel.ProvenanceError, ProvenanceError);

  const error = new Kernel.ProvenanceError('boom');
  assert.equal(error.name, 'ProvenanceError');
  assert.equal(error.code, 'PROVENANCE_REQUIRED');
  assert.ok(error instanceof Error);

  // The error thrown from the ingest path is the same class the kernel
  // exposes; previously this was resolved through a lazy require that could
  // silently fall back to plain Error.
  assert.throws(
    () => buildProvenance({}, { strictProvenance: true }),
    (thrown) => thrown instanceof Kernel.ProvenanceError
      && thrown.code === 'PROVENANCE_REQUIRED',
  );
});
