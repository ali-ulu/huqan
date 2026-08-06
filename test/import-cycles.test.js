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

const {
  listSourceFiles,
  buildGraph,
  findCycles,
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
