'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  KINDS,
  parseSemver,
  compareTriples,
  recordViolations,
  windowViolations,
} = require('./deprecation-policy');
const { collectViolations } = require('./check-deprecations');

test('parseSemver reads triples and rejects noise', () => {
  assert.deepEqual(parseSemver('0.12.0'), [0, 12, 0]);
  assert.deepEqual(parseSemver('1.0.0-rc.1'), [1, 0, 0]);
  assert.equal(parseSemver('next major'), null);
  assert.equal(parseSemver(''), null);
});

test('compareTriples orders by major, then minor, then patch', () => {
  assert.equal(compareTriples([0, 12, 0], [0, 12, 0]), 0);
  assert.equal(compareTriples([0, 12, 0], [1, 0, 0]), -1);
  assert.equal(compareTriples([1, 0, 0], [0, 12, 0]), 1);
  assert.equal(compareTriples([0, 11, 9], [0, 12, 0]), -1);
});

test('recordViolations accepts a complete record', () => {
  assert.deepEqual(recordViolations({
    name: 'KernelV1',
    kind: 'export',
    deprecatedIn: '0.12.0',
    removalIn: '1.0.0',
    migrationPath: 'docs/migrations/kernel-v2.md',
  }), []);
});

test('recordViolations names every missing field', () => {
  const problems = recordViolations({ name: 'x', kind: 'nope', deprecatedIn: 'soon', removalIn: 'later' });
  assert.ok(problems.some((p) => p.includes('unknown kind')));
  assert.ok(problems.some((p) => p.includes('deprecatedIn')));
  assert.ok(problems.some((p) => p.includes('removalIn')));
  assert.ok(problems.some((p) => p.includes('migrationPath')));
  assert.ok(KINDS.includes('export'), 'policy knows the export kind');
});

test('windowViolations fires only once the removal release arrives', () => {
  const record = { name: 'KernelV1', deprecatedIn: '0.12.0', removalIn: '1.0.0' };
  assert.deepEqual(windowViolations(record, '0.12.0'), []);
  assert.deepEqual(windowViolations(record, '0.13.0'), []);
  assert.equal(windowViolations(record, '1.0.0').length, 1);
  assert.equal(windowViolations({ ...record, removalIn: '0.11.0' }, '0.12.0').length, 2);
});

test('collectViolations wants a warning and a guide for a kept feature', () => {
  const record = {
    name: 'KernelV1',
    kind: 'export',
    deprecatedIn: '0.12.0',
    removalIn: '1.0.0',
    migrationPath: 'docs/migrations/does-not-exist.md',
    warnedIn: ['index.js'],
  };
  const at012Real = collectViolations([record], '0.12.0');
  assert.deepEqual(
    at012Real,
    ['KernelV1: migration guide missing at docs/migrations/does-not-exist.md'],
    'the real index.js now warns, only the guide reference is fictional',
  );
  const at012Both = collectViolations(
    [{ ...record, migrationPath: 'docs/migrations/does-not-exist.md', warnedIn: ['no/such/file.js'] }],
    '0.12.0',
  );
  assert.ok(at012Both.some((v) => v.includes('no runtime warning')), 'a missing file cannot warn');
  assert.ok(at012Both.some((v) => v.includes('migration guide missing')));
});

test('collectViolations stays silent when nothing is recorded', () => {
  assert.deepEqual(collectViolations([], '0.12.0'), []);
});
