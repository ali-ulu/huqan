'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseInvariantRows,
  validateSecurityInvariants,
} = require('../scripts/check-security-invariants');

function fixture(rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-security-invariants-'));
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  const lines = [
    '# Security Invariants',
    '',
    '| ID | Security invariant | Test references |',
    '|---|---|---|',
  ];
  for (const [id, invariant, file] of rows) {
    if (file) {
      fs.writeFileSync(path.join(root, file), '// fixture\n', 'utf8');
      lines.push(`| ${id} | ${invariant} | \`${file}\` |`);
    } else {
      lines.push(`| ${id} | ${invariant} | none |`);
    }
  }
  fs.writeFileSync(path.join(root, 'SECURITY_INVARIANTS.md'), lines.join('\n') + '\n', 'utf8');
  return root;
}

test('parses invariant rows and test references', () => {
  const rows = parseInvariantRows('| SI-01 | Cannot self-approve | `test/approval-flow.test.js` |');
  assert.deepEqual(rows, [{
    id: 'SI-01',
    invariant: 'Cannot self-approve',
    references: ['test/approval-flow.test.js'],
  }]);
});

test('accepts 5-7 invariants whose referenced tests exist', () => {
  const root = fixture([
    ['SI-01', 'one', 'test/one.test.js'],
    ['SI-02', 'two', 'test/two.test.js'],
    ['SI-03', 'three', 'test/three.test.js'],
    ['SI-04', 'four', 'test/four.test.js'],
    ['SI-05', 'five', 'test/five.test.js'],
  ]);
  const result = validateSecurityInvariants({ rootDir: root });
  assert.deepEqual(result.errors, []);
});

test('fails when an invariant has no concrete test reference', () => {
  const root = fixture([
    ['SI-01', 'one', 'test/one.test.js'],
    ['SI-02', 'two', 'test/two.test.js'],
    ['SI-03', 'three', 'test/three.test.js'],
    ['SI-04', 'four', 'test/four.test.js'],
    ['SI-05', 'five', null],
  ]);
  const result = validateSecurityInvariants({ rootDir: root });
  assert(result.errors.some((error) => error.includes('SI-05: no test reference')));
});

test('fails when a referenced test file does not exist', () => {
  const root = fixture([
    ['SI-01', 'one', 'test/one.test.js'],
    ['SI-02', 'two', 'test/two.test.js'],
    ['SI-03', 'three', 'test/three.test.js'],
    ['SI-04', 'four', 'test/four.test.js'],
    ['SI-05', 'five', 'test/five.test.js'],
  ]);
  fs.unlinkSync(path.join(root, 'test/five.test.js'));
  const result = validateSecurityInvariants({ rootDir: root });
  assert(result.errors.some((error) => error.includes('referenced test does not exist')));
});

test('fails outside the bounded 5-7 invariant set', () => {
  const root = fixture([
    ['SI-01', 'one', 'test/one.test.js'],
    ['SI-02', 'two', 'test/two.test.js'],
    ['SI-03', 'three', 'test/three.test.js'],
    ['SI-04', 'four', 'test/four.test.js'],
  ]);
  const result = validateSecurityInvariants({ rootDir: root });
  assert(result.errors.some((error) => error.includes('expected 5-7 security invariants')));
});
