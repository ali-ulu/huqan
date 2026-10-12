'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readNamedArithmeticFunction } = require('../lib/experience/arithmetic-function');
const { readArithmeticModule } = require('../lib/experience/expression-adaptation');
const read = (content, extra = {}) => readNamedArithmeticFunction(content,
  { functionName: 'double', readExpression: readArithmeticModule, ...extra });

test('selects a full unique function and preserves all unrelated module bytes', () => {
  const content = "const dependency = require('safe');\nfunction other(n) { return n + 1; }\n"
    + 'function double(n) { /* preserve */ return n + 1; /* tail */ }\nmodule.exports = double;';
  const result = read(content);
  assert.ok(result);
  assert.equal(result.evaluate(3), 4);
  assert.equal(result.parameter, 'n');
  assert.equal(result.canonicalExpression, '(n + 1)');
  assert.equal(content.split(result.find).length, 2);
  const rewritten = content.replace(result.find, () => result.instantiate('n * 2'));
  assert.equal(rewritten, content.replace('/* preserve */ return n + 1;', '/* preserve */ return n * 2;'));
  assert.equal(result.instantiate('$$'), 'function double(n) { /* preserve */ return $$; /* tail */ }');
});

test('ignores function-shaped strings and comments without executing source', () => {
  const content = "throw new Error('must not execute');\n// function double(n) { return n + 1; }\n"
    + "const text = 'function double(n) { return n + 1; }';\nfunction double(n) { return n + 1; }";
  assert.ok(read(content));
  assert.equal(read("const text = 'function double(n) { return n + 1; }';"), null);
});

test('refuses unsupported declaration, scope, body, syntax and lexical forms', () => {
  for (const content of [
    'function double(n) { return n + 1; } function double(n) { return n + 2; }',
    'function double(n) { return n + 1; } function outer() { function double(n) { return n + 2; } }',
    'function outer() { function double(n) { return n + 1; } }',
    'async function double(n) { return n + 1; }',
    'function* double(n) { return n + 1; }',
    'const chosen = function double(n) { return n + 1; };',
    'function double(n, m) { return n + 1; }',
    'function double(n = 1) { return n + 1; }',
    'function double(n) { const m = n; return m + 1; }',
    'function double(n) { return n + 1; sideEffect(); }',
    'function double(n) { return n + other; }',
    'function double(n) { return\nn + 1; }',
    'function double(n) { return /*\n*/ n + 1; }',
    'function double(n) { return n + ; }',
    'const regex = /text/; function double(n) { return n + 1; }',
    'const text = `text`; function double(n) { return n + 1; }',
    'function double(\\u006e) { return n + 1; }',
  ]) assert.equal(read(content), null, content);
});

test('bounds inputs and allows leaf expressions only through an explicit parser option', () => {
  assert.equal(read(' '.repeat(131073)), null);
  assert.equal(read('function double(n) { return n; }'), null);
  assert.ok(read('function double(n) { return n; }', { allowLeaf: true }));
  assert.equal(read('function double(n) { return n + 1; }', { readExpression: undefined }), null);
});

test('refuses rebinding, redeclaration and unsupported potential writes', () => {
  const declaration = 'function double(n) { return n + 1; }\n';
  for (const suffix of [
    'var double = n => n * 100;', 'var other = 1, double;',
    'let double;', 'const double = n => n;',
    'double = n => n * 100;', 'double += 1;', 'double **= 2;',
    'double &&= other;', 'double ||= other;', 'double ??= other;',
    'double++;', '++double;', 'double--;', '--double;',
    '[double] = values;', '({ value: double } = values);',
    'var { value: double } = values;', 'var [double] = values;',
    'for (double of values) {}', 'function outer(double) { return double; }',
  ]) assert.equal(read(declaration + suffix + '\nmodule.exports = double;'), null, suffix);
});

test('accepts plain exports and performs compile-only validation', () => {
  const declaration = 'function double(n) { return n + 1; }\n';
  assert.ok(read(declaration + 'module.exports = double;'));
  assert.ok(read(declaration + 'exports.double = double;'));
  assert.ok(read(declaration + 'module.exports = double'));
  const before = globalThis.__arithmeticFunctionExecuted;
  assert.ok(read('globalThis.__arithmeticFunctionExecuted = true;\n' + declaration + 'module.exports = double;'));
  assert.equal(globalThis.__arithmeticFunctionExecuted, before);
});

test('accepts CommonJS object values, shorthand and calls without allowing binding writes', () => {
  const declaration = 'function double(n) { return n + 1; }\n';
  const helpers = "const path = require('node:path');\nfunction helper(x) { return double(x); }\n";
  assert.ok(read(declaration + helpers + 'module.exports = { calculate: double, helper, separator: path.sep };'));
  assert.ok(read(declaration + helpers + 'module.exports = { double, helper };'));
  assert.ok(read(declaration + helpers + 'module.exports = { double: double, helper };'));
  assert.equal(read(declaration + 'module.exports = { value: ({ double } = values) };'), null);
  for (const write of ['double = helper;', '[double] = values;', '({ double } = values);',
    'function shadow(double) { return double(1); }', 'var double = helper;']) {
    assert.equal(read(declaration + helpers + write + '\nmodule.exports = { calculate: double, helper };'), null, write);
  }
});

test('accepts the selected calculate name as an export property key without permitting rebinding', () => {
  const declaration = 'function calculate(x) { return x + 1; }\n';
  const helpers = 'function helper(x) { return calculate(x); }\n';
  const exported = 'module.exports = { calculate: calculate, helper };';
  assert.ok(read(declaration + helpers + exported, { functionName: 'calculate' }));
  for (const write of ['calculate = helper;', 'var calculate = helper;',
    'function shadow(calculate) { return calculate(1); }', '({ calculate } = values);',
    'module.exports = { calculate: ({ calculate } = values) };']) {
    assert.equal(read(declaration + helpers + write + '\n' + exported, { functionName: 'calculate' }), null, write);
  }
});
