'use strict';

const { types } = require('node:util');
const OPERATORS = Object.freeze(['>', '<', '===', '!==']);
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000 && !Object.is(value, -0);
function fields(value, names) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && keys.every(key => typeof key === 'string' && names.includes(key)
    && Object.getOwnPropertyDescriptor(value, key).enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function array(value, limit, accept) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let at = 0; at < value.length; at += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(at));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !accept(descriptor.value)) return false;
  }
  return true;
}
function inspectStatefulFoldProgram(data) {
  const invalid = { ok: false, reason: 'STATEFUL_FOLD_PROGRAM_INVALID' };
  if (!fields(data, ['type', 'seed', 'emptyResult', 'guard', 'update']) || data.type !== 'stateful-fold'
    || !['first', 'empty'].includes(data.seed) || !integer(data.emptyResult)
    || !fields(data.guard, ['operator']) || !OPERATORS.includes(data.guard.operator)) return invalid;
  const update = data.update;
  if (!(fields(update, ['type']) && ['acc', 'item'].includes(update.type))
    && !(fields(update, ['type', 'value']) && update.type === 'integer'
      && [0, 1, 2, 3].includes(update.value) && !Object.is(update.value, -0))) return invalid;
  const program = Object.freeze({ type: data.type, seed: data.seed, emptyResult: data.emptyResult,
    guard: Object.freeze({ operator: data.guard.operator }), update: Object.freeze({ ...update }) });
  return { ok: true, program, canonicalExpression: JSON.stringify(program), evaluate(input) {
    if (!array(input, 128, integer)) throw new TypeError('STATEFUL_FOLD_INPUT_INVALID');
    if (!input.length) return program.emptyResult;
    let acc = program.seed === 'first' ? input[0] : program.emptyResult;
    for (let at = program.seed === 'first' ? 1 : 0; at < input.length; at += 1) {
      const item = input[at];
      const match = program.guard.operator === '>' ? item > acc : program.guard.operator === '<' ? item < acc
        : program.guard.operator === '===' ? item === acc : item !== acc;
      if (match) acc = program.update.type === 'item' ? item : program.update.type === 'integer' ? program.update.value : acc;
    }
    return acc;
  } };
}
function searchStatefulFoldPrograms(options) {
  const empty = { candidates: [], enumerated: 0, searchBudget: 48, matchingExpressions: 0,
    candidateLimit: 8, omittedCandidates: 0 };
  if (!fields(options, ['examples']) || !array(options.examples, 32, row => fields(row, ['input', 'expected'])
    && array(row.input, 128, integer) && integer(row.expected)) || options.examples.length < 3) return empty;
  const examples = options.examples;
  if (!examples.some(row => !row.input.length)
    || new Set(examples.map(row => JSON.stringify(row.input))).size !== examples.length) return empty;
  const emptyResult = examples.find(row => !row.input.length).expected;
  const updates = [{ type: 'acc' }, { type: 'item' }, ...[0, 1, 2, 3].map(value => ({ type: 'integer', value }))];
  const result = { ...empty, candidates: [] };
  for (const seed of ['first', 'empty']) for (const operator of OPERATORS) for (const update of updates) {
    const inspected = inspectStatefulFoldProgram({ type: 'stateful-fold', seed, emptyResult, guard: { operator }, update });
    result.enumerated += 1;
    if (!examples.every(row => Object.is(inspected.evaluate(row.input), row.expected))) continue;
    result.matchingExpressions += 1;
    if (result.candidates.length < result.candidateLimit) result.candidates.push({ program: inspected.program,
      canonicalExpression: inspected.canonicalExpression });
  }
  result.omittedCandidates = result.matchingExpressions - result.candidates.length;
  return result;
}
module.exports = { inspectStatefulFoldProgram, searchStatefulFoldPrograms };
