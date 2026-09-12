'use strict';

/**
 * The numeric and text helpers VerifyService uses to compare claims.
 *
 * Taken out of lib/verify.js, which sat exactly on the 800-line threshold, so
 * that giving VerifyService a named host context did not push it over. All
 * three were already pure -- none of them touched `this` -- which is why they
 * could move without a behaviour question.
 *
 * The Turkish numeral table was written out twice, once in each of the two
 * functions below that need it. One copy now.
 */

const TURKISH_NUMERALS = Object.freeze({
  bir: 1, iki: 2, uc: 3, dort: 4, bes: 5, alti: 6, yedi: 7, sekiz: 8, dokuz: 9,
  on: 10, yirmi: 20, otuz: 30, kirk: 40, elli: 50, altmis: 60, yetmis: 70,
  seksen: 80, doksan: 90, yuz: 100, bin: 1000,
});

/**
 * Read a bare numeric comparison such as `3 > 2`, or null when the text is
 * not one. A trailing group of exactly three decimals is refused: `1.000` is
 * a thousand in some locales and one in others, and guessing would decide a
 * verdict on a typography convention.
 */
function parseNumericComparison(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const match = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*(==|=|!=|<>|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  if ([match[1], match[3]].some((value) => /\.\d{3}$/.test(value))) return null;

  const left = Number(match[1]);
  const operator = match[2];
  const right = Number(match[3]);
  if (!Number.isFinite(left) || !Number.isFinite(right)
    || !Number.isSafeInteger(Math.trunc(left)) || !Number.isSafeInteger(Math.trunc(right))) return null;

  let ok = false;
  switch (operator) {
    case '=':
    case '==': ok = left === right; break;
    case '!=':
    case '<>': ok = left !== right; break;
    case '<': ok = left < right; break;
    case '>': ok = left > right; break;
    case '<=': ok = left <= right; break;
    case '>=': ok = left >= right; break;
    default: return null;
  }

  return { ok, left, operator, right, text: raw };
}

/** Every number in the text, digits and Turkish numerals alike, deduplicated
 *  and sorted into a stable comparison key -- or null when there are none. */
function extractNumbers(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const nums = [];
  for (const word of words) {
    if (/^\d+$/.test(word)) nums.push(parseInt(word, 10));
    else if (TURKISH_NUMERALS[word] !== undefined) nums.push(TURKISH_NUMERALS[word]);
  }
  const digitMatches = text.match(/\d+/g);
  if (digitMatches) for (const digits of digitMatches) nums.push(Number(digits));
  if (nums.length === 0) return null;
  return [...new Set(nums)].sort((a, b) => a - b).join(',');
}

/** The text with every number removed, so two claims that differ only in
 *  their figures can be recognised as being about the same thing. */
function getTextCore(text) {
  let core = text.toLowerCase();
  for (const [word, num] of Object.entries(TURKISH_NUMERALS)) {
    core = core.replace(new RegExp(`\\b${word}\\b`, 'g'), String(num));
  }
  return core.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = { parseNumericComparison, extractNumbers, getTextCore, TURKISH_NUMERALS };
