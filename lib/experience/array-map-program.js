'use strict';
const { types } = require('node:util');
const { inspectArrayFoldProgram, enumerateArrayExpressions } = require('./array-fold-program');
const MAX_ENUMERATED = 4105;
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000 && !Object.is(value, -0);
function fields(value, names) {
  return value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === names.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && names.includes(key)
      && Object.getOwnPropertyDescriptor(value, key).enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function validArray(value, limit = 128) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit) return false;
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let at = 0; at < value.length; at += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(at));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !integer(descriptor.value)) return false;
  }
  return true;
}
function hasAccumulator(tree) {
  return tree.type === 'acc' || tree.type === 'binary' && (hasAccumulator(tree.left) || hasAccumulator(tree.right));
}
function inspectArrayMapProgram(data) {
  const invalid = { ok: false, reason: 'ARRAY_MAP_PROGRAM_INVALID' };
  if (!fields(data, ['type', 'expression']) || data.type !== 'map') return invalid;
  const folded = inspectArrayFoldProgram({ type: 'fold', seed: 0, update: data.expression });
  if (!folded.ok || hasAccumulator(folded.program.update)) return invalid;
  const program = Object.freeze({ type: 'map', expression: folded.program.update });
  return { ok: true, program, canonicalExpression: JSON.stringify(program), evaluate: input => {
    if (!validArray(input)) throw new TypeError('ARRAY_MAP_INPUT_INVALID');
    const output = [];
    for (let at = 0; at < input.length; at += 1) {
      const value = folded.evaluate([input[at]]);
      if (Object.is(value, -0)) throw new RangeError('ARRAY_MAP_OUTPUT_INVALID');
      output.push(value);
    }
    return output;
  } };
}
function searchArrayMapPrograms(options = {}) {
  const result = { candidates: [], enumerated: 0, searchBudget: MAX_ENUMERATED,
    matchingExpressions: 0, candidateLimit: 8, omittedCandidates: 0 };
  if (!fields(options, ['examples'])) return result;
  const examples = options.examples;
  if (types.isProxy(examples) || !Array.isArray(examples) || Object.getPrototypeOf(examples) !== Array.prototype
    || examples.length < 3 || examples.length > 32 || Reflect.ownKeys(examples).length !== examples.length + 1) return result;
  const rows = [];
  for (let at = 0; at < examples.length; at += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(examples, String(at));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return result;
    const row = descriptor.value;
    if (!fields(row, ['input', 'expected']) || !validArray(row.input) || !validArray(row.expected)
      || row.input.length !== row.expected.length) return result;
    rows.push(row);
  }
  if (!rows.some(row => row.input.length === 0)
    || new Set(rows.map(row => JSON.stringify(row.input))).size !== rows.length) return result;
  for (const expression of enumerateArrayExpressions(false)) {
    const inspected = inspectArrayMapProgram({ type: 'map', expression });
    result.enumerated += 1;
    let matches = false;
    try { matches = rows.every(row => inspected.evaluate(row.input).every((value, at) => Object.is(value, row.expected[at]))); }
    catch { matches = false; }
    if (!matches) continue;
    result.matchingExpressions += 1;
    if (result.candidates.length < result.candidateLimit)
      result.candidates.push({ program: inspected.program, canonicalExpression: inspected.canonicalExpression });
  }
  result.omittedCandidates = result.matchingExpressions - result.candidates.length;
  return result;
}
module.exports = { inspectArrayMapProgram, searchArrayMapPrograms };
