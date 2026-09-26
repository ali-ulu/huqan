'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isCompositionRoot,
  snapshot,
} = require('../scripts/architecture-snapshot');

test('kernel.js is an explicit composition root for runtime assembly (#2127)', () => {
  assert.equal(isCompositionRoot('kernel.js'), true);

  const kernel = snapshot().find((row) => row.file === 'kernel.js');
  assert.ok(kernel, 'kernel.js must remain visible in the architecture snapshot');
  assert.equal(kernel.signals.includes('DIP'), false, 'composition-root construction must not be reported as DIP');
  assert.ok(kernel.signals.some((signal) => signal.startsWith('FANOUT:')), 'remaining fan-out debt must stay visible');
});

test('ordinary domain modules are not made composition roots by the Kernel exemption', () => {
  assert.equal(isCompositionRoot('lib/verify.js'), false);
  assert.equal(isCompositionRoot('lib/memory-store.js'), false);
});

test('executables package.json ships as bin are measured as product code (#2401)', () => {
  const { isProduct, packagedBins, classify } = require('../scripts/architecture-snapshot');
  const bins = packagedBins();
  assert.ok(bins.has('bin/huqan-gate-hook.js'), 'the packaged huqan-gate hook is a bin entry');
  assert.equal(isProduct('bin/huqan-gate-hook.js'), true);
  assert.equal(isProduct('bin/not-shipped.js'), false, 'an unlisted bin/ file stays tooling');
  assert.equal(isProduct('scripts/architecture-snapshot.js'), false);
  // Derived, not listed: drop the entry from package.json and it leaves product scope.
  const withoutGate = packagedBins({ name: 'huqan', bin: { huqan: './cli.js' } });
  assert.equal(isProduct('bin/huqan-gate-hook.js', withoutGate), false);
  // A packaged bin over the accepted size lands in a product band, not tooling.
  const groups = classify([{ file: 'bin/huqan-gate-hook.js', lines: 450, signals: [] }]);
  assert.equal(groups.recorded.length, 1);
  assert.equal(groups.tooling.length, 0);
});

test('composition roots are an explicit, dated list, not a file-name pattern (#2401)', () => {
  const { COMPOSITION_ROOTS, compositionRootViolations } = require('../scripts/architecture-snapshot');
  for (const entry of COMPOSITION_ROOTS) {
    assert.equal(isCompositionRoot(entry.file), true, entry.file);
    assert.match(entry.review_by, /^\d{4}-\d{2}-\d{2}$/);
  }
  // A name alone no longer exempts a file from the DIP signal.
  assert.equal(isCompositionRoot('lib/some-new-factory.js'), false);
  assert.equal(isCompositionRoot('lib/http/ingest-approval-runtime.js'), false);
  assert.deepEqual(compositionRootViolations(), []);

  const sources = { 'lib/a.js': 'new Graph()', 'lib/b.js': 'module.exports = {};' };
  const violations = compositionRootViolations([
    { file: 'lib/a.js', why: 'fixture', review_by: '2026-01-01' },
    { file: 'lib/b.js', why: 'fixture', review_by: '2099-01-01' },
    { file: 'lib/gone.js', why: 'fixture', review_by: '2099-01-01' },
  ], { today: '2026-09-26', readSource: (file) => sources[file] ?? null });
  assert.equal(violations.length, 3, JSON.stringify(violations));
});

test('a long if/else-if chain is an OCP signal like a long switch (#2401)', () => {
  const { longestIfChain } = require('../scripts/architecture-snapshot-scope');
  const chain = (n) => Array.from({ length: n }, (_, i) => `${i ? ' else ' : ''}if (x === ${i}) { f(${i}); }`).join('');
  assert.equal(longestIfChain(chain(6)), 6);
  assert.equal(longestIfChain(`${chain(5)} else { g(); }`), 5);
  assert.equal(longestIfChain('if (a) { if (b) { } else if (c) { } }'), 2);
  // No measured file carries one: the last chain (risk-classify flag aliases) is a table now.
  const { stripComments } = require('../scripts/check-import-cycles');
  const chained = snapshot().filter((row) => longestIfChain(stripComments(
    fs.readFileSync(path.join(__dirname, '..', row.file), 'utf8'))) >= 6);
  assert.deepEqual(chained.map((row) => row.file), []);
});
