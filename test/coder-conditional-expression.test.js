'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { synthesizeArithmetic } = require('../lib/coder/arithmetic-synthesis');
const { searchConditionalExpressions } = require('../lib/coder/conditional-expression-search');
const { readConditionalExpression } = require('../lib/experience/conditional-expression-program');
const inputs = [-9, -4, -1, 0, 2, 5, 11];
function request(expected, family = 'conditional-expression') {
  return { id: 'conditional', level: 'l0', allowedPaths: ['a.js'], operation: { type: 'replace_text', path: 'a.js' },
    test: { command: 'node accept.js' }, synthesis: { family, functionName: 'answer',
      examples: inputs.map(input => ({ input, expected: expected(input) })) } };
}
test('explicit conditional grammar solves scalar branches beyond legacy arithmetic', () => {
  for (const expected of [x => Math.max(0, x), x => Math.abs(x), x => x >= 1 ? x + 2 : 0 - x]) {
    const content = 'function answer(x) { return x + 1; }\nmodule.exports = answer;';
    const legacy = synthesizeArithmetic({ task: request(expected, 'arithmetic-expression'), content });
    assert.equal(legacy.reason, 'SYNTHESIS_NO_SOLUTION');
    const result = synthesizeArithmetic({ task: request(expected), content });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.plan.searchComplete, true);
    assert.ok(result.plan.candidates.length <= 8);
  }
});

test('conditional intent refuses signed zero without changing legacy arithmetic semantics', () => {
  for (const row of [{ input: -0, expected: 0 }, { input: 0, expected: -0 }]) {
    const task = request(Math.abs);
    task.synthesis.examples = [row, { input: -1, expected: 1 }, { input: 2, expected: 2 }];
    const result = synthesizeArithmetic({ task, content: 'function answer(x) { return x + 1; }' });
    assert.equal(result.reason, 'SYNTHESIS_EXAMPLES_INVALID');
  }
});

test('conditional search refuses malformed observations without evaluating executable properties', () => {
  let accessed = 0;
  const executable = { get input() { accessed++; throw new Error('getter executed'); }, expected: 1 };
  for (const examples of [new Array(3), [null, null, null],
    [executable, { input: 1, expected: 1 }, { input: 2, expected: 2 }],
    ...[NaN, Infinity, 0n, undefined, -0].map(input => [
      { input, expected: 0 }, { input: -1, expected: 1 }, { input: 2, expected: 2 },
    ])]) {
    const result = searchConditionalExpressions({ parameter: 'x', examples });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.enumerated, 0);
    assert.equal(result.reason, 'SYNTHESIS_EXAMPLES_INVALID');
  }
  assert.equal(accessed, 0);
});

test('conditional reader is lazy and refuses executable or nested expressions', () => {
  const lazy = readConditionalExpression('(x === 0 ? 1 : (x % x))', 'x');
  assert.ok(lazy);
  assert.equal(lazy.evaluate(0), 1);
  assert.equal(lazy.evaluate(2), 0);
  for (const expression of ['x > 0 ? process.exit() : 0', 'x > 0 ? x : (x > 1 ? 1 : 0)',
    'x > 0 ? other : 0', 'x > 0 ? x.value : 0', 'x > 0 ? x++ : 0']) {
    assert.equal(readConditionalExpression(expression, 'x'), null);
  }
});

test('unobserved arms are not synthesized and unsuccessful search still reports its bounded work', () => {
  const result = searchConditionalExpressions({ parameter: 'x',
    examples: [10, 11, 12].map(input => ({ input, expected: input })) });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.searchComplete, true);
  assert.ok(result.enumerated > result.branchEnumerated);
  assert.ok(result.guardEnumerated > 0);
  assert.equal(result.pairEnumerated, 0);
  assert.ok(result.enumerated <= result.searchBudget);
});

test('search retains valid one-operation constant arms instead of losing their syntax by folding', () => {
  for (const expected of [4, 6, 9]) {
    const examples = [-3, -2, -1, 0, 1, 2, 3].map(input => ({ input, expected: input >= 0 ? expected : 0 }));
    const result = searchConditionalExpressions({ parameter: 'x', examples });
    assert.ok(result.candidates.length > 0, `missing constant branch ${expected}`);
    for (const candidate of result.candidates) {
      const program = readConditionalExpression(candidate.expression, 'x');
      assert.ok(program);
      for (const row of examples) assert.equal(program.evaluate(row.input), row.expected);
    }
    assert.ok(result.enumerated <= result.searchBudget);
  }
});
