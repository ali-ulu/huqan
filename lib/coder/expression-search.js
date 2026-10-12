'use strict';

// Enumerate syntax trees, not source templates. All nodes come from this fixed
// grammar; neither requirements nor target code can introduce an executable op.
const OPERATORS = ['+', '-', '*', '%'];
const MAX_OPERATIONS = 2;
const MAX_EXPRESSIONS = 4105;
const MAX_CANDIDATES = 8;

function constant(value) {
  return { text: value < 0 ? `(0 - ${Math.abs(value)})` : String(value),
    evaluate: () => value, value, total: true };
}

function combine(operator, left, right) {
  if (['+', '*'].includes(operator) && left.text > right.text) [left, right] = [right, left];
  const calculate = (a, b) => ({ '+': () => a + b, '-': () => a - b,
    '*': () => a * b, '%': () => a % b })[operator]();
  if (left.value !== undefined && right.value !== undefined) {
    const value = calculate(left.value, right.value);
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) return constant(value);
  }
  if ((operator === '-' && right.value === 0)
    || (operator === '*' && right.value === 1)) return left;
  if (operator === '*' && left.value === 1) return right;
  if (operator === '-' && left.text === right.text && left.total) return constant(0);
  return { text: `(${left.text} ${operator} ${right.text})`,
    evaluate: input => calculate(left.evaluate(input), right.evaluate(input)),
    total: left.total && right.total && (operator !== '%' || (right.value !== undefined && right.value !== 0)) };
}

function searchExpressions({ parameter, examples }) {
  const levels = [[{ text: parameter, evaluate: input => input, total: true }, ...[0, 1, 2, 3].map(constant)]];
  const seen = new Set();
  const solutions = [];
  let enumerated = 0;
  function consider(node, operations, level) {
    enumerated += 1;
    if (seen.has(node.text)) return;
    seen.add(node.text);
    level.push(node);
    if (examples.every(row => {
      const value = node.evaluate(row.input);
      return Number.isSafeInteger(value) && Object.is(value, row.expected);
    })) solutions.push({ expression: node.text, operations });
  }
  // Do not mutate the leaf array while considering its nodes.
  for (const node of levels[0]) {
    enumerated += 1;
    seen.add(node.text);
    if (examples.every(row => Object.is(node.evaluate(row.input), row.expected)))
      solutions.push({ expression: node.text, operations: 0 });
  }
  for (let cost = 1; cost <= MAX_OPERATIONS; cost += 1) {
    const level = [];
    for (let leftCost = 0; leftCost < cost; leftCost += 1) {
      for (const left of levels[leftCost]) for (const right of levels[cost - 1 - leftCost]) {
        for (const operator of OPERATORS) consider(combine(operator, left, right), cost, level);
      }
    }
    levels.push(level);
  }
  solutions.sort((a, b) => a.operations - b.operations || (a.expression < b.expression ? -1 : a.expression > b.expression ? 1 : 0));
  return { candidates: solutions.slice(0, MAX_CANDIDATES), enumerated,
    searchBudget: MAX_EXPRESSIONS, maxOperations: MAX_OPERATIONS,
    matchingExpressions: solutions.length, candidateLimit: MAX_CANDIDATES,
    omittedCandidates: Math.max(0, solutions.length - MAX_CANDIDATES) };
}

module.exports = { searchExpressions };
