'use strict';

const { types } = require('node:util');
const { inspectArrayFoldProgram } = require('./array-fold-program');
const COMPARISON_OPERATIONS = Object.freeze({
  '>': (item, threshold) => item > threshold,
  '>=': (item, threshold) => item >= threshold,
  '<': (item, threshold) => item < threshold,
  '<=': (item, threshold) => item <= threshold,
  '===': (item, threshold) => item === threshold,
  '!==': (item, threshold) => item !== threshold,
});
const COMPARISONS = Object.freeze(Object.keys(COMPARISON_OPERATIONS));
const THRESHOLDS = [-3, -2, -1, 0, 1, 2, 3];
const SEARCH_BUDGET = 6300;
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000 && !Object.is(value, -0);
function fields(value, names) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === names.length && own.every(key => typeof key === 'string' && names.includes(key)
    && Object.getOwnPropertyDescriptor(value, key).enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function inputValid(input) {
  return !types.isProxy(input) && Array.isArray(input) && Object.getPrototypeOf(input) === Array.prototype
    && input.length <= 128 && Reflect.ownKeys(input).every(key => key === 'length'
      || typeof key === 'string' && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < input.length)
    && Array.from({ length: input.length }, (_, at) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(at));
      return descriptor && Object.hasOwn(descriptor, 'value') && integer(descriptor.value);
    }).every(Boolean);
}
function matches(item, guard) {
  return Object.hasOwn(COMPARISON_OPERATIONS, guard.operator)
    && COMPARISON_OPERATIONS[guard.operator](item, guard.threshold);
}
function inspectConditionalFoldProgram(data, type) {
  const invalid = { ok: false, reason: 'GUARDED_FOLD_PROGRAM_INVALID' };
  if (!fields(data, ['type', 'seed', 'guard', 'update']) || data.type !== type
    || !fields(data.guard, ['operator', 'threshold']) || !COMPARISONS.includes(data.guard.operator)
    || !(type === 'guarded-fold' ? THRESHOLDS.includes(data.guard.threshold) : integer(data.guard.threshold))
    || Object.is(data.guard.threshold, -0)) return invalid;
  const fold = inspectArrayFoldProgram({ type: 'fold', seed: data.seed, update: data.update });
  if (!fold.ok || fold.program.update.type === 'binary'
    && [fold.program.update.left, fold.program.update.right].some(node => node.type === 'binary')) return invalid;
  const guard = Object.freeze({ operator: data.guard.operator, threshold: data.guard.threshold });
  const program = Object.freeze({ type, seed: fold.program.seed, guard, update: fold.program.update });
  return { ok: true, program, canonicalExpression: JSON.stringify(program), evaluate(input) {
    if (!inputValid(input)) throw new TypeError('GUARDED_FOLD_INPUT_INVALID');
    const selected = [];
    for (let at = 0; at < input.length; at += 1) {
      const item = Object.getOwnPropertyDescriptor(input, String(at)).value;
      if (matches(item, guard)) selected.push(item);
    }
    return fold.evaluate(selected);
  } };
}
function inspectGuardedFoldProgram(data) { return inspectConditionalFoldProgram(data, 'guarded-fold'); }
function inspectThresholdFoldProgram(data) { return inspectConditionalFoldProgram(data, 'threshold-fold'); }

function searchConditionalFoldPrograms(options, type) {
  const empty = { candidates: [], enumerated: 0, searchBudget: type === 'guarded-fold' ? SEARCH_BUDGET : 57600,
    matchingExpressions: 0, candidateLimit: 8, omittedCandidates: 0 };
  if (!fields(options, ['examples'])) return empty;
  const examples = options.examples;
  if (types.isProxy(examples) || !Array.isArray(examples) || Object.getPrototypeOf(examples) !== Array.prototype
    || Reflect.ownKeys(examples).some(key => key !== 'length' && (typeof key !== 'string'
      || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= examples.length)) || examples.length < 3 || examples.length > 32
    || !Array.from({ length: examples.length }, (_, at) => {
      const descriptor = Object.getOwnPropertyDescriptor(examples, String(at));
      return descriptor && Object.hasOwn(descriptor, 'value') && fields(descriptor.value, ['input', 'expected'])
        && inputValid(descriptor.value.input) && integer(descriptor.value.expected);
    }).every(Boolean) || !examples.some(row => row.input.length === 0)
    || new Set(examples.map(row => JSON.stringify(row.input))).size !== examples.length) return empty;
  const seed = examples.find(row => row.input.length === 0).expected;
  if (![-1, 0, 1].includes(seed)) return empty;
  let thresholds = THRESHOLDS;
  if (type === 'threshold-fold') {
    const values = new Set(THRESHOLDS);
    for (const row of examples) for (const item of row.input) for (const value of [item - 1, item, item + 1])
      if (integer(value)) values.add(value);
    if (values.size > 64) return { ...empty, reason: 'PROJECT_COMPUTE_THRESHOLD_SEARCH_OVER_CAP', thresholdCount: values.size };
    thresholds = [...values].sort((left, right) => left - right);
  }
  const budget = type === 'threshold-fold' ? { ...empty, searchBudget: thresholds.length * 900, thresholdCount: thresholds.length } : empty;
  const leaves = [{ type: 'acc' }, { type: 'item' }, ...[0, 1, 2, 3].map(value => ({ type: 'integer', value }))];
  const updates = [...leaves];
  for (const operator of ['+', '-', '*', '%']) for (const left of leaves) for (const right of leaves)
    updates.push({ type: 'binary', operator, left, right });
  const candidates = [];
  let enumerated = 0; let matchingExpressions = 0;
  for (const operator of COMPARISONS) for (const threshold of thresholds) for (const update of updates) {
    const inspected = inspectConditionalFoldProgram({ type, seed, guard: { operator, threshold }, update }, type);
    enumerated += 1;
    let matched;
    try { matched = examples.every(row => Object.is(inspected.evaluate(row.input), row.expected)); }
    catch { matched = false; }
    if (!matched) continue;
    matchingExpressions += 1;
    if (candidates.length < 8) candidates.push({ program: inspected.program, canonicalExpression: inspected.canonicalExpression });
  }
  return { ...budget, candidates, enumerated, matchingExpressions, omittedCandidates: matchingExpressions - candidates.length };
}
function searchGuardedFoldPrograms(options = {}) { return searchConditionalFoldPrograms(options, 'guarded-fold'); }
function searchThresholdFoldPrograms(options = {}) { return searchConditionalFoldPrograms(options, 'threshold-fold'); }
module.exports = { inspectGuardedFoldProgram, searchGuardedFoldPrograms, inspectThresholdFoldProgram, searchThresholdFoldPrograms };
