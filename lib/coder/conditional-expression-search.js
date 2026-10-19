'use strict';
const { enumerateExpressions } = require('./expression-search');
const { conditionalGuards, readConditionalExpression } = require('../experience/conditional-expression-program');
const { plain, onlyKeys, safeData } = require('./project-spec-data');
// Search one guard and at most one arithmetic operation in each branch.
// Include raw branch enumeration, guards, arm filters and matching pairs.
const BRANCH_BUDGET = 105;
const SEARCH_BUDGET = BRANCH_BUDGET + 42 * (1 + 2 * BRANCH_BUDGET + BRANCH_BUDGET ** 2);
function validConditionalExamples(examples) {
  return safeData(examples) && Array.isArray(examples) && examples.length >= 3 && examples.length <= 32
    && Reflect.ownKeys(examples).length === examples.length + 1
    && Array.from({ length: examples.length }, (_, at) => Object.hasOwn(examples, at)).every(Boolean)
    && examples.every(row => plain(row) && onlyKeys(row, ['input', 'expected'])
      && ['input', 'expected'].every(key => Number.isSafeInteger(row[key])
        && Math.abs(row[key]) <= 1000000 && !Object.is(row[key], -0)))
    && new Set(examples.map(row => row.input)).size >= 3;
}
function searchConditionalExpressions({ parameter, examples }) {
  const result = { candidates: [], enumerated: 0, searchBudget: SEARCH_BUDGET, candidateLimit: 8,
    matchingExpressions: 0, omittedCandidates: 0, searchComplete: false, branchEnumerated: 0,
    guardEnumerated: 0, branchChecks: 0, pairEnumerated: 0,
    maxConditionals: 1, maxBranchOperations: 1, thresholdRange: [-3, 3] };
  if (!validConditionalExamples(examples)) return { ...result, reason: 'SYNTHESIS_EXAMPLES_INVALID' };
  if (typeof parameter !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(parameter))
    return { ...result, reason: 'SYNTHESIS_TARGET_UNSUPPORTED' };
  const branches = [];
  result.branchEnumerated = enumerateExpressions(parameter, (node, operations) => {
    // Cache outputs only, not inferred semantic equivalence. Invalid outputs
    // on an unselected branch do not reject a lazy conditional.
    branches.push({ expression: node.text, operations, values: examples.map(row => {
      const value = node.evaluate(row.input);
      return Number.isSafeInteger(value) && !Object.is(value, -0) && Math.abs(value) <= 1000000 ? value : null;
    }) });
  }, 1, false);
  result.enumerated = result.branchEnumerated;
  for (const guard of conditionalGuards) {
    result.guardEnumerated += 1;
    result.enumerated += 1;
    const mask = examples.map(row => guard.evaluate([row.input]).length === 1);
    // Both arms require training evidence; no unconstrained branch generation.
    if (!mask.some(Boolean) || mask.every(Boolean)) continue;
    const fits = selected => branches.filter(branch => {
      result.branchChecks += 1;
      result.enumerated += 1;
      return examples.every((row, at) => mask[at] !== selected || Object.is(branch.values[at], row.expected));
    });
    const yes = fits(true), no = fits(false);
    for (const left of yes) for (const right of no) {
      result.pairEnumerated += 1;
      if (++result.enumerated > SEARCH_BUDGET) return { ...result, reason: 'SYNTHESIS_CONDITIONAL_SEARCH_EXHAUSTED' };
      const { operator, threshold } = guard.program.guard;
      const expression = `(${parameter} ${operator} ${threshold} ? ${left.expression} : ${right.expression})`;
      // Re-read emitted text with the same closed reader used by memory/runtime.
      const parsed = readConditionalExpression(expression, parameter);
      if (!parsed || !examples.every(row => Object.is(parsed.evaluate(row.input), row.expected))) continue;
      result.matchingExpressions += 1;
      const candidate = { expression: parsed.canonicalExpression, operations: left.operations + right.operations + 1 };
      result.candidates.push(candidate);
      result.candidates.sort((a, b) => a.operations - b.operations || (a.expression < b.expression ? -1 : a.expression > b.expression ? 1 : 0));
      result.candidates = result.candidates.slice(0, result.candidateLimit);
    }
  }
  result.candidates.sort((a, b) => a.operations - b.operations || (a.expression < b.expression ? -1 : a.expression > b.expression ? 1 : 0));
  result.candidates = result.candidates.slice(0, result.candidateLimit);
  result.omittedCandidates = result.matchingExpressions - result.candidates.length;
  result.searchComplete = true;
  return result;
}
module.exports = { searchConditionalExpressions, validConditionalExamples };
