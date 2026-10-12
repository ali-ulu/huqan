'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readArrayFoldTarget, searchArrayFoldPrograms, adaptArrayFold } = require('../lib/experience/array-fold-program');
const read = content => readArrayFoldTarget(content, { functionName: 'calculate' });
const baseline = 'function calculate(values) { return 0; }';

test('accepts bounded decimal integer stubs and rejects alternate numeric spellings', () => {
  assert.equal(read('function calculate(values) { return 10; }').evaluate([]), 10);
  assert.equal(read('function calculate(values) { return -100; }').evaluate([]), -100);
  for (const literal of ['01', '0x10', '1e2', '-0', '1000001'])
    assert.equal(read(`function calculate(values) { return ${literal}; }`), null, literal);
});

test('discovers composed folds and roundtrips generated source without executing modules', () => {
  for (const [inputs, expected, heldout, answer] of [
    [[[], [2], [3, 4]], [0, 2, 7], [-3, 8, 1], 6],
    [[[], [2], [3, 4]], [0, 4, 25], [-3, 8, 1], 74],
    [[[], [2], [3, 4]], [1, 2, 12], [-3, 8, 1], -24],
    [[[], [2], [3, 4]], [0, -2, -7], [-3, 8, 1], -6],
    [[[], [2], [3, 4]], [0, 1, 2], [-3, 8, 1], 3],
  ]) {
    const search = searchArrayFoldPrograms({ examples: inputs.map((input, at) => ({ input, expected: expected[at] })) });
    assert.ok(search.enumerated < 12000);
    assert.ok(search.candidates.length > 0 && search.candidates.length <= 8);
    const parsed = search.candidates.map(candidate => read(read(baseline).instantiate(candidate.program)));
    assert.ok(parsed.every(Boolean));
    assert.ok(parsed.some(candidate => Object.is(candidate.evaluate(heldout), answer)));
  }
  const prior = globalThis.__foldSourceExecuted;
  assert.ok(read('globalThis.__foldSourceExecuted = true;\n' + baseline + '\nmodule.exports = { calculate: calculate };'));
  assert.equal(globalThis.__foldSourceExecuted, prior);
});

test('validates input bounds, preserves arrays and refuses accessors and unsafe intermediates', () => {
  const candidate = searchArrayFoldPrograms({ examples: [
    { input: [], expected: 0 }, { input: [2], expected: 2 }, { input: [3, 4], expected: 7 },
  ] }).candidates[0];
  const parsed = read(read(baseline).instantiate(candidate.program));
  const input = Object.freeze([1, 2, 3]);
  assert.equal(parsed.evaluate(input), 6);
  assert.deepEqual(input, [1, 2, 3]);
  for (const invalid of [Array(2), Array(129).fill(1), [1000001], [NaN], 'array'])
    assert.throws(() => parsed.evaluate(invalid), /INPUT_INVALID/);
  let accessed = false;
  const accessor = [1];
  Object.defineProperty(accessor, '0', { get() { accessed = true; return 1; } });
  assert.throws(() => parsed.evaluate(accessor), /INPUT_INVALID/);
  assert.equal(accessed, false);
  const product = read('function calculate(values) { let acc = 1; for (const item of values) { acc = (acc * item); } return acc; }');
  assert.throws(() => product.evaluate([1000000, 1000000, 1000000]), /INTERMEDIATE_INVALID/);
  const modulo = read('function calculate(values) { let acc = 1; for (const item of values) { acc = (acc % item); } return acc; }');
  assert.throws(() => modulo.evaluate([0]), /INTERMEDIATE_INVALID/);
});

test('refuses unsupported body, mutation, rebinding, shadowing and ASI', () => {
  for (const source of [
    'function calculate(values) { return\n0; }',
    'function calculate(values) { return\n0; /* return */ }',
    'function calculate(values) { return -0; }',
    'function calculate(calculate) { return 0; }',
    'function calculate(acc) { return 0; }',
    'function calculate(values) { return "0"; }',
    'function calculate(values) { values.push(1); return 0; }',
    'function calculate(values) { let acc = 0; for (const item of values) { acc = (acc + other); } return acc; }',
    'function calculate(values) { let acc = 0; while (true) {} return acc; }',
    baseline + ' calculate = other;', baseline + ' var calculate = other;',
    baseline + ' function helper(calculate) { return calculate(1); }',
    baseline + ' const fake = /calculate/;',
  ]) assert.equal(read(source), null, source);
  assert.equal(read(' '.repeat(131073)), null);
  assert.equal(readArrayFoldTarget('function acc(values) { return 0; }', { functionName: 'acc' }), null);
  assert.equal(searchArrayFoldPrograms({ examples: [{ input: [1], expected: 1 }] }).candidates.length, 0);
  assert.equal(searchArrayFoldPrograms({ examples: [
    { input: [], expected: -0 }, { input: [1], expected: 1 }, { input: [2], expected: 2 },
  ] }).candidates.length, 0);
});

test('adapts sealed full function across names only when baseline AST matches', () => {
  const program = searchArrayFoldPrograms({ examples: [
    { input: [], expected: 0 }, { input: [2], expected: 2 }, { input: [3, 4], expected: 7 },
  ] }).candidates[0].program;
  const newText = read(baseline).instantiate(program);
  const target = 'function total(items) { /* retain */ return 0; }\nmodule.exports = { total };';
  const adapted = adaptArrayFold({ oldText: baseline, newText, content: target, functionName: 'total' });
  assert.equal(adapted.ok, true);
  assert.equal(readArrayFoldTarget(adapted.newText, { functionName: 'total' }).evaluate([4, 5]), 9);
  assert.deepEqual(adapted.bindings, { calculate: 'total', values: 'items' });
  assert.equal(adaptArrayFold({ oldText: baseline, newText, content: target.replace('return 0', 'return 1'), functionName: 'total' }).ok, false);
});
