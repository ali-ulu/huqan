'use strict';

/**
 * Unit coverage for the numeric and text helpers behind verify.
 *
 * These decide whether a bare comparison is reported as verified or
 * contradicted, and whether two claims that differ only in their figures are
 * recognised as being about the same thing. Before this file existed three
 * mutations survived the suite: turning `>` into `>=`, deleting the guard
 * that refuses a locale-ambiguous `1.000`, and dropping the sort that makes
 * the extracted-number key stable. Each of those changes a verdict.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNumericComparison, extractNumbers, getTextCore } = require('../lib/verify-numeric-text');

test('each comparison operator decides the verdict on its own terms', () => {
  assert.equal(parseNumericComparison('3 > 2').ok, true);
  assert.equal(parseNumericComparison('2 > 3').ok, false);
  assert.equal(parseNumericComparison('3 > 3').ok, false, '> must not accept equality');
  assert.equal(parseNumericComparison('3 >= 3').ok, true);
  assert.equal(parseNumericComparison('2 < 3').ok, true);
  assert.equal(parseNumericComparison('3 < 3').ok, false, '< must not accept equality');
  assert.equal(parseNumericComparison('3 <= 3').ok, true);
  assert.equal(parseNumericComparison('3 = 3').ok, true);
  assert.equal(parseNumericComparison('3 == 3').ok, true);
  assert.equal(parseNumericComparison('3 != 4').ok, true);
  assert.equal(parseNumericComparison('3 <> 3').ok, false);
});

test('the parsed parts are returned alongside the verdict', () => {
  assert.deepEqual(parseNumericComparison(' -2.5 <= 4 '), {
    ok: true, left: -2.5, operator: '<=', right: 4, text: '-2.5 <= 4',
  });
});

test('a locale-ambiguous thousands group is refused rather than guessed', () => {
  // `1.000` is one in some locales and a thousand in others. Guessing would
  // decide a verdict on a typography convention.
  assert.equal(parseNumericComparison('1.000 > 999'), null);
  assert.equal(parseNumericComparison('2 > 1.000'), null);
  // Only the three-decimal shape is ambiguous. Others parse normally, and
  // then answer on their value: 1.0000 really is not greater than 999.
  assert.equal(parseNumericComparison('1.0000 > 999').ok, false, 'four decimals parse');
  assert.equal(parseNumericComparison('1.00 > 0.5').ok, true, 'two decimals parse');
});

test('text that is not a bare comparison is not one', () => {
  for (const input of ['', '   ', null, undefined, 'a cat is an animal', '3 >', '> 2', '3 ? 2', '3 > 2 > 1']) {
    assert.equal(parseNumericComparison(input), null, `${JSON.stringify(input)} is not a comparison`);
  }
});

test('a number too large to hold exactly is refused', () => {
  assert.equal(parseNumericComparison('9007199254740993 > 1'), null);
});

test('extracted numbers are deduplicated and sorted, so the key is stable', () => {
  assert.equal(extractNumbers('10 3 10 7'), '3,7,10');
  assert.equal(extractNumbers('7 3 10'), '3,7,10', 'input order must not change the key');
});

test('Turkish numerals count as numbers', () => {
  assert.equal(extractNumbers('uc kedi'), '3');
  assert.equal(extractNumbers('yuz yirmi'), '20,100');
  assert.equal(extractNumbers('bes ve 5'), '5', 'the word and the digit are the same number');
});

test('text with no numbers has no key', () => {
  assert.equal(extractNumbers('kedi hayvandir'), null);
});

test('the text core drops the figures so two claims can be compared', () => {
  assert.equal(getTextCore('B737 has 3 engines'), 'b has engines');
  assert.equal(getTextCore('B737 has uc engines'), 'b has engines');
  assert.equal(
    getTextCore('ucak 200 kisi tasir'),
    getTextCore('ucak 300 kisi tasir'),
    'claims differing only in their figures share a core',
  );
});

test('a numeral inside a longer word is not replaced', () => {
  assert.equal(getTextCore('birlik'), 'birlik');
});
