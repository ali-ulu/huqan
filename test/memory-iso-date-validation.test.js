'use strict';

/**
 * isValidIsoDate is the guard behind every date filter in the memory surface
 * (memory-query-engine, memory-event-read, memory-store.memoriesBetween).
 *
 * It used to be `!isNaN(new Date(str))`, which accepts '2024', '0' and '12345'.
 * A filter of `createdAfter: '0'` therefore passed validation and the instant
 * `new Date('0')` happens to parse to became a real query boundary -- the
 * "ISO validated" guarantee did not exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isValidIsoDate } = require('../lib/memory-store-utils');
const { runQuery } = require('../lib/memory-query-engine');

const VALID = [
  '2026-01-01',
  '2026-06-03T00:00:00.000Z',
  '2026-06-03T00:00:00Z',
  '2026-06-03T12:30',
  '2026-06-03T00:00:00+03:00',
  '2026-06-03T00:00:00+0300',
  '2024-02-29',
];

const INVALID = [
  '2024',
  '0',
  '12345',
  '2024-13-99',
  '2025-02-30',
  '2026-06-03T24:00:00Z',
  '2026-06-03T12:60',
  '2026-6-3',
  'Mon Jan 01 2024',
  '',
  '   ',
];

test('isValidIsoDate accepts the ISO-8601 forms this codebase produces', () => {
  for (const value of VALID) {
    assert.equal(isValidIsoDate(value), true, `${value} is a valid ISO-8601 timestamp`);
  }
});

test('isValidIsoDate rejects strings new Date would have accepted', () => {
  for (const value of INVALID) {
    assert.equal(isValidIsoDate(value), false, `${value} is not an ISO-8601 timestamp`);
  }
});

test('isValidIsoDate rejects calendar dates that do not exist', () => {
  assert.equal(isValidIsoDate('2025-02-29'), false, '2025 is not a leap year');
  assert.equal(isValidIsoDate('2026-04-31'), false, 'April has 30 days');
  assert.equal(isValidIsoDate('2026-00-10'), false);
});

test('isValidIsoDate rejects non-strings', () => {
  for (const value of [null, undefined, 42, {}, [], new Date()]) {
    assert.equal(isValidIsoDate(value), false);
  }
});

function queryContext() {
  return {
    memories: new Map(),
    isActiveRecord: (record) => record.status === 'active',
  };
}

test('query date filters reject a value that is not ISO-8601', () => {
  for (const field of ['createdAfter', 'createdBefore', 'updatedAfter', 'updatedBefore']) {
    for (const broken of ['0', '2024', '2024-13-99']) {
      const rejected = runQuery(queryContext(), { [field]: broken });
      assert.equal(rejected.ok, false, `${field}: '${broken}' must not pass validation`);
      assert.equal(rejected.error.code, 'VALIDATION_ERROR');
      assert.match(rejected.error.message, new RegExp(field));
    }

    const accepted = runQuery(queryContext(), { [field]: '2026-06-03T00:00:00.000Z' });
    assert.equal(accepted.ok, true, `${field}: a real timestamp must still pass`);
  }
});
