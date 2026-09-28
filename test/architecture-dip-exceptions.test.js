'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// #2268: the DIP signal is a regex over constructor calls, and it cannot tell
// an injected collaborator from a throwaway local structure. Constructions that
// are not coupling defects are recorded explicitly -- with a reason and a
// review date, like scripts/check-layers.js's ALLOWED -- instead of being moved
// into a "*runtime*" file just to silence the regex. An expired entry, or one
// that no longer matches anything, fails the gate.

const snapshotModule = require('../scripts/architecture-snapshot');

const SCRATCH_GRAPH = 'lib/self-healer/source-dependency-graph.js';

test('the scratch Graph in source-dependency-graph is a recorded, dated exception', () => {
  const { DIP_ALLOWED } = snapshotModule;
  assert.ok(Array.isArray(DIP_ALLOWED), 'DIP_ALLOWED must be exported');
  const entry = DIP_ALLOWED.find((item) => item.file === SCRATCH_GRAPH);
  assert.ok(entry, `${SCRATCH_GRAPH} must be recorded`);
  assert.match(entry.why, /\S{20,}|#2268/, 'an exception states why');
  assert.match(entry.review_by, /^\d{4}-\d{2}-\d{2}$/, 'an exception has a review date');
});

test('a recorded exception removes the DIP signal but nothing else', () => {
  const row = snapshotModule.snapshot().find((item) => item.file === SCRATCH_GRAPH);
  assert.ok(row, 'the file is measured');
  assert.ok(!row.signals.includes('DIP'), `unexpected signals: ${JSON.stringify(row.signals)}`);
});

test('the live exception list is neither expired nor stale', () => {
  assert.deepEqual(snapshotModule.dipExceptionViolations(), []);
});

// #3101: both are runtime classes whose collaborators are injected and
// defaulted in the same constructor. The construction is a default, not a
// collaborator the caller forgot to pass, so the regex reports it and the
// dated exception records why it is not a defect.
const RUNTIME_DEFAULTS = ['kernel.v2.js', 'agent.v3.js'];

test('kernel.v2.js and agent.v3.js are recorded, dated DIP exceptions', () => {
  const { DIP_ALLOWED } = snapshotModule;
  for (const file of RUNTIME_DEFAULTS) {
    const entry = DIP_ALLOWED.find((item) => item.file === file);
    assert.ok(entry, `${file} must be recorded`);
    assert.ok(entry.why.trim().length > 50, 'an exception states why in a sentence');
    assert.match(entry.review_by, /^\d{4}-\d{2}-\d{2}$/, 'an exception has a review date');
  }
});

test('their recorded exceptions remove the DIP signal but nothing else', () => {
  const rows = snapshotModule.snapshot();
  for (const file of RUNTIME_DEFAULTS) {
    const row = rows.find((item) => item.file === file);
    assert.ok(row, `${file} is measured`);
    assert.ok(!row.signals.includes('DIP'), `${file} still reports ${JSON.stringify(row.signals)}`);
  }
});

test('an expired, a stale and a composition-root entry are each reported', () => {
  const { dipExceptionViolations } = snapshotModule;
  const sources = {
    'lib/constructs.js': "const g = new Graph({ useSQLite: false });",
    'lib/constructs-nothing.js': "module.exports = {};",
    'lib/kernel-factory.js': "module.exports = () => new KernelV2();",
  };
  const readSource = (file) => (file in sources ? sources[file] : null);
  const today = '2026-09-14';
  const violations = dipExceptionViolations([
    { file: 'lib/constructs.js', why: 'fixture: still valid', review_by: '2026-12-31' },
    { file: 'lib/constructs.js', why: 'fixture: expired', review_by: '2026-01-01' },
    { file: 'lib/constructs-nothing.js', why: 'fixture: stale', review_by: '2026-12-31' },
    { file: 'lib/missing.js', why: 'fixture: gone', review_by: '2026-12-31' },
    { file: 'lib/kernel-factory.js', why: 'fixture: root', review_by: '2026-12-31' },
  ], { today, readSource });

  assert.equal(violations.length, 4, JSON.stringify(violations));
  assert.ok(violations.some((v) => /expired/.test(v) && /lib\/constructs\.js/.test(v)));
  assert.ok(violations.some((v) => /stale/.test(v) && /constructs-nothing/.test(v)));
  assert.ok(violations.some((v) => /stale/.test(v) && /missing/.test(v)));
  assert.ok(violations.some((v) => /composition root/.test(v) && /kernel-factory/.test(v)));
});
