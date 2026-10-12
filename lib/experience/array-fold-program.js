'use strict';

const { readNamedArithmeticFunction } = require('./arithmetic-function');
const { types } = require('node:util');
const OPERATORS = ['+', '-', '*', '%'];
const MAX_ENUMERATED = 7062;
const validInteger = value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000;

function validInput(input) {
  if (types.isProxy(input) || !Array.isArray(input) || input.length > 128) return false;
  for (let at = 0; at < input.length; at += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(at));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !validInteger(descriptor.value)) return false;
  }
  return true;
}

function expressionValue(tree, acc, item) {
  if (tree.type === 'acc') return acc;
  if (tree.type === 'item') return item;
  if (tree.type === 'integer') return tree.value;
  const left = expressionValue(tree.left, acc, item);
  const right = expressionValue(tree.right, acc, item);
  const value = tree.operator === '+' ? left + right : tree.operator === '-' ? left - right
    : tree.operator === '*' ? left * right : left % right;
  if (!Number.isSafeInteger(value)) throw new RangeError('ARRAY_FOLD_INTERMEDIATE_INVALID');
  return value;
}

function evaluate(program, input) {
  if (!validInput(input)) throw new TypeError('ARRAY_FOLD_INPUT_INVALID');
  if (program.type === 'constant') return program.value;
  let acc = program.seed;
  for (let at = 0; at < input.length; at += 1) acc = expressionValue(program.update, acc, input[at]);
  return acc;
}

function inspectArrayFoldProgram(data) {
  const invalid = { ok: false, reason: 'ARRAY_FOLD_PROGRAM_INVALID' };
  const seen = new Set();
  let operators = 0;
  const fields = (value, names) => {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const own = Reflect.ownKeys(value);
    if (own.length !== names.length || !own.every(key => typeof key === 'string' && names.includes(key)
      && Object.getOwnPropertyDescriptor(value, key).enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) return false;
    return true;
  };
  const readNode = (node, depth = 0) => {
    if (depth > 2 || seen.has(node) || !fields(node, ['type']) && !fields(node, ['type', 'value'])
      && !fields(node, ['type', 'operator', 'left', 'right'])) return null;
    seen.add(node);
    let result = null;
    if ((node.type === 'acc' || node.type === 'item') && fields(node, ['type'])) result = { type: node.type };
    else if (node.type === 'integer' && fields(node, ['type', 'value'])
      && Number.isInteger(node.value) && node.value >= 0 && node.value <= 3 && !Object.is(node.value, -0))
      result = { type: 'integer', value: node.value };
    else if (node.type === 'binary' && fields(node, ['type', 'operator', 'left', 'right'])
      && OPERATORS.includes(node.operator) && ++operators <= 2) {
      const left = readNode(node.left, depth + 1);
      const right = readNode(node.right, depth + 1);
      if (left && right) result = { type: 'binary', operator: node.operator, left, right };
    }
    seen.delete(node);
    return result ? Object.freeze(result) : null;
  };

  if (!fields(data, ['type', 'seed', 'update']) || data.type !== 'fold'
    || ![-1, 0, 1].includes(data.seed) || Object.is(data.seed, -0)) return invalid;
  seen.add(data);
  const update = readNode(data.update);
  if (!update) return invalid;
  const program = Object.freeze({ type: 'fold', seed: data.seed, update });
  return { ok: true, program, canonicalExpression: JSON.stringify(program), evaluate: input => evaluate(program, input) };
}

function renderExpression(tree) {
  if (tree.type === 'integer') return String(tree.value);
  if (tree.type === 'acc' || tree.type === 'item') return tree.type;
  return `(${renderExpression(tree.left)} ${tree.operator} ${renderExpression(tree.right)})`;
}

function render(program, parameter) {
  if (program.type === 'constant') return ` return ${program.value}; `;
  return ` let acc = ${program.seed}; for (const item of ${parameter}) { acc = ${renderExpression(program.update)}; } return acc; `;
}

function parseBody(body, { parameter, bodyStart, tokens }) {
  if (tokens.some(token => token.value === null) || parameter === 'acc' || parameter === 'item'
    || tokens.some((token, at) => token.value === 'return' && /[\r\n\u2028\u2029]/u.test(
      body.slice(token.end - bodyStart, tokens[at + 1]?.start - bodyStart)))) return null;
  const values = tokens.map(token => token.value);
  const constant = /^return(-?(?:0|[1-9][0-9]*));$/u.exec(values.join(''));
  let program;
  if (constant) {
    const value = Number(constant[1]);
    if (!validInteger(value) || Object.is(value, -0)) return null;
    program = { type: 'constant', value };
  } else {
    const prefix = ['let', 'acc', '=', null, ';', 'for', '(', 'const', 'item', 'of', parameter, ')', '{', 'acc', '='];
    let start = 3;
    let seed = Number(values[start]);
    if (values[start] === '-') { seed = -Number(values[start + 1]); start += 1; }
    if (![-1, 0, 1].includes(seed) || Object.is(seed, -0)) return null;
    const shifted = [...values.slice(0, 3), String(seed), ...values.slice(start + 1)];
    if (!prefix.every((value, at) => value === null || shifted[at] === value)
      || shifted.slice(-5).join(' ') !== '; } return acc ;') return null;
    const expression = shifted.slice(prefix.length, -5);
    let at = 0;
    let operators = 0;
    const parse = () => {
      const value = expression[at++];
      if (value === 'acc' || value === 'item') return { type: value };
      if (/^[0-3]$/u.test(value || '')) return { type: 'integer', value: Number(value) };
      if (value !== '(' || ++operators > 2) return null;
      const left = parse();
      const operator = expression[at++];
      const right = parse();
      if (!left || !right || !OPERATORS.includes(operator) || expression[at++] !== ')') return null;
      return { type: 'binary', operator, left, right };
    };
    const update = parse();
    if (!update || at !== expression.length) return null;
    program = { type: 'fold', seed, update };
  }
  return { program, canonicalExpression: JSON.stringify(program), evaluate: input => evaluate(program, input), render };
}

function readArrayFoldTarget(content, { functionName } = {}) {
  if (functionName === 'acc' || functionName === 'item') return null;
  const target = readNamedArithmeticFunction(content, { functionName, parseBody });
  return target && target.parameter !== functionName ? target : null;
}

function enumerateArrayExpressions(includeAccumulator = true) {
  const leaves = [...(includeAccumulator ? [{ type: 'acc' }] : []), { type: 'item' },
    ...[0, 1, 2, 3].map(value => ({ type: 'integer', value }))];
  const one = [];
  for (const operator of OPERATORS) for (const left of leaves) for (const right of leaves)
    one.push({ type: 'binary', operator, left, right });
  const expressions = [...leaves, ...one];
  for (const operator of OPERATORS) for (const nested of one) for (const leaf of leaves) {
    expressions.push({ type: 'binary', operator, left: nested, right: leaf });
    expressions.push({ type: 'binary', operator, left: leaf, right: nested });
  }
  return expressions;
}

function searchArrayFoldPrograms({ examples } = {}) {
  const empty = { candidates: [], enumerated: 0, searchBudget: MAX_ENUMERATED,
    matchingExpressions: 0, candidateLimit: 8, omittedCandidates: 0 };
  if (!Array.isArray(examples) || examples.length < 3 || examples.length > 32
    || !examples.every(row => row && validInput(row.input) && validInteger(row.expected))
    || !examples.some(row => row.input.length === 0)
    || new Set(examples.map(row => JSON.stringify(row.input))).size < 3) return empty;
  const expressions = enumerateArrayExpressions();
  let enumerated = 0;
  let matches = 0;
  const candidates = [];
  const seed = examples.find(row => row.input.length === 0).expected;
  if (![-1, 0, 1].includes(seed) || Object.is(seed, -0)) return empty;
  for (const update of expressions) {
    const program = { type: 'fold', seed, update };
    enumerated += 1;
    let matched = false;
    try { matched = examples.every(row => Object.is(evaluate(program, row.input), row.expected)); }
    catch { matched = false; }
    if (!matched) continue;
    matches += 1;
    if (candidates.length < 8) candidates.push({ program, expression: renderExpression(update),
      canonicalExpression: JSON.stringify(program) });
  }
  return { ...empty, candidates, enumerated, matchingExpressions: matches, omittedCandidates: matches - candidates.length };
}

function adaptArrayFold({ oldText, newText, content, functionName } = {}) {
  if (![oldText, newText, content].every(value => typeof value === 'string')
    || oldText.length > 4096 || newText.length > 4096) return { ok: false, reason: 'adaptation_limit' };
  const sourceName = /^\s*function\s+([A-Za-z_$][\w$]*)/u.exec(oldText)?.[1];
  const before = readArrayFoldTarget(oldText, { functionName: sourceName });
  const after = readArrayFoldTarget(newText, { functionName: sourceName });
  const target = readArrayFoldTarget(content, { functionName: functionName || sourceName });
  if (!before || !after || !target || before.parameter !== after.parameter
    || before.canonicalExpression !== target.canonicalExpression
    || before.functionName === before.parameter || target.functionName === target.parameter)
    return { ok: false, reason: 'adaptation_unsupported' };
  return { ok: true, oldText: target.find, newText: target.instantiate(after.program),
    bindings: { [sourceName]: target.functionName, [before.parameter]: target.parameter },
    qualification: { sourceText: before.find, targetText: target.find } };
}

module.exports = { readArrayFoldTarget, searchArrayFoldPrograms, adaptArrayFold, inspectArrayFoldProgram, enumerateArrayExpressions };
