'use strict';
const { Script } = require('node:vm');
const { readNamedArithmeticFunction } = require('./arithmetic-function');
const { tokenize, parse, render } = require('./integer-expression-ast');
const { inspectArrayFilterProgram } = require('./array-filter-program');
const { inspectArrayMapProgram } = require('./array-map-program');
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000 && !Object.is(value, -0);
const comparisons = ['>', '>=', '<', '<=', '===', '!=='];
const guards = [];
for (let threshold = -3; threshold <= 3; threshold += 1) for (const operator of comparisons) {
  const inspected = inspectArrayFilterProgram({ type: 'filter', guard: { operator, threshold } });
  if (!guards.some(guard => JSON.stringify(guard.program.guard) === JSON.stringify(inspected.program.guard))) guards.push(inspected);
}
function strip(tokens) {
  while (tokens[0]?.value === '(' && tokens.at(-1)?.value === ')') {
    let depth = 0, whole = true;
    for (let at = 0; at < tokens.length - 1; at += 1) {
      depth += tokens[at].value === '(' ? 1 : tokens[at].value === ')' ? -1 : 0;
      if (depth === 0) { whole = false; break; }
    }
    if (!whole) break;
    tokens = tokens.slice(1, -1);
  }
  return tokens;
}
function branch(tokens, parameter, maxOperations) {
  const tree = parse(tokens); let operations = 0;
  function convert(node) {
    if (!node) return null;
    if (node.type === 'id') return node.value === parameter ? { type: 'item' } : null;
    if (node.type === 'number') return /^[0-3]$/.test(node.value) ? { type: 'integer', value: Number(node.value) } : null;
    if (++operations > maxOperations) return null;
    const left = convert(node.left), right = convert(node.right);
    return left && right ? { type: 'binary', operator: node.operator, left, right } : null;
  }
  const expression = convert(tree);
  const inspected = expression && inspectArrayMapProgram({ type: 'map', expression });
  if (!inspected?.ok) return null;
  return { tree, evaluate: value => inspected.evaluate([value])[0],
    render: name => render(tree, new Map([[parameter, name]])) };
}
// One conditional only. Branches share the established integer arithmetic IR;
// predicates reuse its existing integer-boundary canonicalization and evaluator.
function readConditionalExpression(expression, parameter) {
  let tokens = tokenize(expression, { conditional: true });
  if (!tokens || tokens.length > 64 || tokens.some(token => token.kind === 'opaque')) return null;
  tokens = strip(tokens);
  const questions = tokens.reduce((all, token, at) => token.value === '?' ? [...all, at] : all, []);
  let evaluate, canonicalExpression;
  if (!questions.length) {
    const arithmetic = branch(tokens, parameter, 2);
    if (!arithmetic) return null;
    evaluate = arithmetic.evaluate; canonicalExpression = arithmetic.render(parameter);
  } else {
    if (questions.length !== 1) return null;
    const question = questions[0];
    const colons = tokens.reduce((all, token, at) => token.value === ':' ? [...all, at] : all, []);
    if (colons.length !== 1 || colons[0] <= question) return null;
    const colon = colons[0], guardTokens = strip(tokens.slice(0, question));
    const [input, comparator, ...thresholdTokens] = guardTokens;
    const thresholdText = thresholdTokens.map(token => token.value).join('');
    const threshold = Number(thresholdText);
    if (input?.kind !== 'id' || input.value !== parameter || !comparisons.includes(comparator?.value)
      || !/^-?[0-4]$/.test(thresholdText) || Object.is(threshold, -0)) return null;
    const guard = inspectArrayFilterProgram({ type: 'filter', guard: { operator: comparator.value, threshold } });
    const yes = branch(tokens.slice(question + 1, colon), parameter, 1);
    const no = branch(tokens.slice(colon + 1), parameter, 1);
    if (!guard.ok || !yes || !no || !guards.some(known => JSON.stringify(known.program.guard) === JSON.stringify(guard.program.guard))) return null;
    evaluate = value => guard.evaluate([value]).length ? yes.evaluate(value) : no.evaluate(value);
    canonicalExpression = `(${parameter} ${guard.program.guard.operator} ${guard.program.guard.threshold} ? ${yes.render(parameter)} : ${no.render(parameter)})`;
  }
  return { parameter, expression, canonicalExpression, conditional: questions.length === 1,
    evaluate(input) {
      if (!integer(input)) throw new TypeError('CONDITIONAL_INPUT_INVALID');
      const result = evaluate(input);
      if (!integer(result)) throw new RangeError('CONDITIONAL_RESULT_INVALID');
      return result;
    } };
}
function readConditionalModule(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 131072) return null;
  try { new Script(content); } catch { return null; } // Syntax only: never run target JavaScript.
  const match = /^\s*module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*=>\s*([^;]+?)\s*;?\s*$/.exec(content);
  return match ? readConditionalExpression(match[2], match[1]) : null;
}
function readConditionalTarget(content, { functionName } = {}) {
  if (typeof functionName !== 'string') return null;
  return readNamedArithmeticFunction(content, { functionName, allowLeaf: true, readExpression: readConditionalModule });
}
function adaptConditional({ oldText, newText, content, functionName }) {
  const sourceName = /^\s*function\s+([A-Za-z_$][\w$]*)/u.exec(oldText)?.[1];
  const before = readConditionalTarget(oldText, { functionName: sourceName });
  const after = readConditionalTarget(newText, { functionName: sourceName });
  const target = readConditionalTarget(content, { functionName: functionName || sourceName });
  if (!before || !after || !target || before.parameter !== after.parameter
    || before.functionName === before.parameter || target.functionName === target.parameter) return { ok: false, reason: 'adaptation_unsupported' };
  // Compare structural expressions under local, bijective parameter binding.
  // Render through tokens rather than substituting arbitrary source text.
  const rename = (text, from, to) => {
    const tokens = tokenize(text, { conditional: true }); let output = text;
    for (const token of tokens.reverse()) if (token.kind === 'id' && token.value === from)
      output = output.slice(0, token.start) + to + output.slice(token.end);
    return output;
  };
  if (rename(before.canonicalExpression, before.parameter, 'input') !== rename(target.canonicalExpression, target.parameter, 'input'))
    return { ok: false, reason: 'adaptation_no_match' };
  return { ok: true, oldText: target.find, newText: target.instantiate(rename(after.canonicalExpression, before.parameter, target.parameter)),
    bindings: { [sourceName]: target.functionName, [before.parameter]: target.parameter },
    qualification: { family: 'conditional-expression', sourceText: before.find, targetText: target.find } };
}
module.exports = { readConditionalExpression, readConditionalTarget, adaptConditional, conditionalGuards: Object.freeze(guards) };
