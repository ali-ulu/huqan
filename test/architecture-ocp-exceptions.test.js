'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// #3101: the OCP signal counts a switch with at least six cases, or an if-chain
// of six. A dispatch over a set the language or a parser closes cannot grow
// with a feature -- there is no case a later PR can add -- so replacing it with
// a registry buys indirection and nothing else. Those are recorded explicitly,
// with a reason and a review date, like DIP_ALLOWED and check-layers.js's
// ALLOWED. An expired entry, or one that no longer matches a signal, fails the
// gate.

const snapshotModule = require('../scripts/architecture-snapshot');

const DATED = [
  { file: 'sandboxRunner.js', why: /typeof|closed by the language|#2179/ },
  { file: 'lib/verify-numeric-text.js', why: /closed by the parser|#2140/ },
];

test('every OCP_ALLOWED entry carries a reason and a review date', () => {
  const { OCP_ALLOWED } = snapshotModule;
  assert.ok(Array.isArray(OCP_ALLOWED), 'OCP_ALLOWED must be exported');
  for (const expected of DATED) {
    const entry = OCP_ALLOWED.find((item) => item.file === expected.file);
    assert.ok(entry, `${expected.file} must be recorded`);
    assert.match(entry.why, expected.why, 'an exception states why');
    assert.match(entry.review_by, /^\d{4}-\d{2}-\d{2}$/, 'an exception has a review date');
  }
});

test('a recorded exception removes the OCP signal but nothing else', () => {
  const rows = snapshotModule.snapshot();
  for (const expected of DATED) {
    const row = rows.find((item) => item.file === expected.file);
    assert.ok(row, `${expected.file} is measured`);
    assert.ok(
      !row.signals.some((signal) => signal.startsWith('OCP:')),
      `${expected.file} still reports ${JSON.stringify(row.signals)}`,
    );
  }
});

test('the live exception list is neither expired nor stale', () => {
  assert.deepEqual(snapshotModule.ocpExceptionViolations(), []);
});

test('ocpSignal counts a six-case switch and a six-long if-chain, and nothing smaller', () => {
  const { ocpSignal } = snapshotModule;
  const switchOf = (cases) => `switch (kind) {\n${Array.from({ length: cases }, (_, i) => `case ${i}: return ${i};`).join('\n')}\n}`;
  // longestIfChain counts braced branches: a braceless branch ends the chain.
  const chainOf = (branches) => Array.from({ length: branches }, (_, i) => `if (kind === ${i}) { return ${i}; }`).join(' else ');
  assert.equal(ocpSignal(switchOf(6)), 6);
  assert.equal(ocpSignal(switchOf(5)), null);
  assert.equal(ocpSignal(chainOf(6)), 6);
  assert.equal(ocpSignal(chainOf(5)), null);
  assert.equal(ocpSignal('module.exports = {};'), null);
});

test('an expired and a stale entry are each reported, a live one is not', () => {
  const { ocpExceptionViolations } = snapshotModule;
  const sources = {
    'lib/dispatch.js': 'switch (kind) {\ncase 1: return 1;\ncase 2: return 2;\ncase 3: return 3;\ncase 4: return 4;\ncase 5: return 5;\ncase 6: return 6;\n}',
    'lib/closed.js': 'if (kind === 1) return 1;\nreturn 0;',
  };
  const readSource = (file) => (file in sources ? sources[file] : null);
  const today = '2026-09-14';
  const violations = ocpExceptionViolations([
    { file: 'lib/dispatch.js', why: 'fixture: still a signal', review_by: '2026-12-31' },
    { file: 'lib/dispatch.js', why: 'fixture: expired', review_by: '2026-01-01' },
    { file: 'lib/closed.js', why: 'fixture: no longer a signal', review_by: '2026-12-31' },
    { file: 'lib/missing.js', why: 'fixture: gone', review_by: '2026-12-31' },
  ], { today, readSource });

  assert.equal(violations.length, 3, JSON.stringify(violations));
  assert.ok(violations.some((v) => /expired/.test(v) && /lib\/dispatch\.js/.test(v)));
  assert.ok(violations.some((v) => /stale/.test(v) && /lib\/closed\.js/.test(v)));
  assert.ok(violations.some((v) => /stale/.test(v) && /lib\/missing\.js/.test(v)));
});
