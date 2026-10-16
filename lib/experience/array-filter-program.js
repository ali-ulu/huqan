'use strict';
const { types } = require('node:util');
const { inspectArrayMapProgram } = require('./array-map-program');
const identity = inspectArrayMapProgram({ type: 'map', expression: { type: 'item' } });
const comparisons = Object.freeze({
  '>=': (item, threshold) => item >= threshold,
  '<=': (item, threshold) => item <= threshold,
  '===': (item, threshold) => item === threshold,
  '!==': (item, threshold) => item !== threshold,
});
function fields(value, names) {
  return value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === names.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && names.includes(key)
      && Object.getOwnPropertyDescriptor(value, key).enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function inspectArrayFilterProgram(data) {
  const invalid = { ok: false, reason: 'ARRAY_FILTER_PROGRAM_INVALID' };
  if (!fields(data, ['type', 'guard']) || data.type !== 'filter'
    || !fields(data.guard, ['operator', 'threshold'])
    || !['>', '>=', '<', '<=', '===', '!=='].includes(data.guard.operator)
    || !Number.isSafeInteger(data.guard.threshold) || Math.abs(data.guard.threshold) > 1000001
    || (['>', '<'].includes(data.guard.operator) && Math.abs(data.guard.threshold) > 1000000)
    || Object.is(data.guard.threshold, -0)) return invalid;
  let { operator, threshold } = data.guard;
  // Integer predicates with equivalent boundaries share one canonical AST.
  if (operator === '>') { operator = '>='; threshold += 1; }
  if (operator === '<') { operator = '<='; threshold -= 1; }
  const guard = Object.freeze({ operator, threshold });
  const program = Object.freeze({ type: 'filter', guard });
  return { ok: true, program, canonicalExpression: JSON.stringify(program), evaluate(input) {
    const values = identity.evaluate(input);
    return values.filter(item => comparisons[operator](item, threshold));
  } };
}
function searchArrayFilterPrograms(options = {}) {
  const result = { candidates: [], enumerated: 0, searchBudget: 384, matchingExpressions: 0,
    candidateLimit: 8, omittedCandidates: 0 };
  if (!fields(options, ['examples'])) return result;
  const examples = options.examples;
  if (types.isProxy(examples) || !Array.isArray(examples) || Object.getPrototypeOf(examples) !== Array.prototype
    || examples.length < 3 || examples.length > 32 || Reflect.ownKeys(examples).length !== examples.length + 1) return result;
  const rows = [];
  for (let at = 0; at < examples.length; at += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(examples, String(at));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !fields(descriptor.value, ['input', 'expected'])) return result;
    try {
      const input = identity.evaluate(descriptor.value.input);
      const expected = identity.evaluate(descriptor.value.expected);
      if (expected.length > input.length) return result;
      rows.push({ input, expected });
    } catch { return result; }
  }
  if (!rows.some(row => row.input.length === 0) || new Set(rows.map(row => JSON.stringify(row.input))).size !== rows.length) return result;
  const thresholds = new Set([-3, -2, -1, 0, 1, 2, 3]);
  for (const row of rows) for (const item of row.input) for (const value of [item - 1, item, item + 1])
    if (Math.abs(value) <= 1000000) thresholds.add(value);
  if (thresholds.size > 64) return { ...result, reason: 'PROJECT_COMPUTE_FILTER_SEARCH_OVER_CAP', thresholdCount: thresholds.size };
  result.thresholdCount = thresholds.size;
  result.searchBudget = thresholds.size * 6;
  const seen = new Set();
  for (const threshold of [...thresholds].sort((left, right) => left - right)) for (const operator of ['>', '>=', '<', '<=', '===', '!==']) {
    const inspected = inspectArrayFilterProgram({ type: 'filter', guard: { operator, threshold } });
    if (seen.has(inspected.canonicalExpression)) continue;
    seen.add(inspected.canonicalExpression); result.enumerated += 1;
    if (!rows.every(row => JSON.stringify(inspected.evaluate(row.input)) === JSON.stringify(row.expected))) continue;
    result.matchingExpressions += 1;
    if (result.candidates.length < result.candidateLimit)
      result.candidates.push({ program: inspected.program, canonicalExpression: inspected.canonicalExpression });
  }
  result.omittedCandidates = result.matchingExpressions - result.candidates.length;
  return result;
}
module.exports = { inspectArrayFilterProgram, searchArrayFilterPrograms };
