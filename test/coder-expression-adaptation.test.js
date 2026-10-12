'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adaptExpression, bindQualification } = require('../lib/experience/expression-adaptation');

test('named-function qualification preserves ambiguity and drift across target formatting', () => {
  const oldText = 'function estimate(n) { return n + 1; }';
  const newText = 'function estimate(n) { return (n * n) + 1; }';
  const target = 'function calculate ( amount ) {\n /* target comment */ return amount + 1;\n}';
  const adapted = adaptExpression({ oldText, newText, content: target, functionName: 'calculate' });
  assert.equal(adapted.ok, true);
  const bind = content => bindQualification(content, adapted.bindings, adapted.qualification);
  assert.equal(bind(`${oldText}\n${oldText}`).split(adapted.oldText).length - 1, 2);
  assert.equal(bind(oldText), adapted.oldText);
  assert.equal(bind('function estimate(n) { return n + 2; }').includes(adapted.oldText), false);
  assert.equal(adapted.newText, target.replace('amount + 1', '((amount * amount) + 1)'));
  const sameName = 'function calculate(amount) { return amount + 1; }';
  const same = adaptExpression({ oldText: sameName,
    newText: sameName.replace('amount + 1', 'amount * 2'), content: target, functionName: 'calculate' });
  const opaque = `const text = '${sameName}';\n// ${sameName}\n`;
  assert.equal(bindQualification(opaque + sameName, same.bindings, same.qualification), opaque + same.oldText);
});

test('adapts learned arithmetic structure and repeated identifier bindings', () => {
  assert.deepEqual(adaptExpression({ oldText: 'n + 1', newText: 'n * 2',
    content: 'module.exports = value => value + 1;' }),
  { ok: true, oldText: 'value + 1', newText: '(value * 2)', bindings: { n: 'value' } });
  assert.equal(adaptExpression({ oldText: 'a + a', newText: 'a * 2', content: 'return value + other;' }).ok, false);
  assert.equal(adaptExpression({ oldText: 'a + b', newText: 'a * b', content: 'return value + value;' }).ok, false);
});

test('qualification binding preserves comments and strings and maps names simultaneously', () => {
  assert.equal(bindQualification('a + b; /* a */ "b";', { a: 'b', b: 'c' }), 'b + c; /* a */ "b";');
});

test('refuses ambiguous matches, new names and expressions outside its grammar', () => {
  for (const input of [
    { oldText: 'n + 1', newText: 'n * 2', content: 'return a + 1; return b + 1;' },
    { oldText: 'n + 1', newText: 'missing * 2', content: 'return a + 1;' },
    { oldText: 'obj.n + 1', newText: 'obj.n * 2', content: 'return obj.a + 1;' },
    { oldText: 'f(n)', newText: 'g(n)', content: 'return f(a);' },
  ]) assert.equal(adaptExpression(input).ok, false);
});

test('never derives a match from strings, comments, member names or regex literals', () => {
  for (const content of ["const s = 'value + 1';", '// value + 1\nreturn 0;',
    '/* value + 1 */ return 0;', 'return obj.value + 1;', 'const r = /value + 1/;',
    'const s = `value + 1`;', 'return longvalue + 10;', 'return value + 1.5;',
    'return !value + 1;', 'return ~value + 1;', 'return typeof value + 1;',
    'return void value + 1;', 'return ++value + 1;', 'return value + 1n;', 'return 0x1 + 1;',
    'return value + 1 * 3;', 'return other * value + 1;', 'return this.#value + 1;',
    'return ! /* note */ value + 1;', 'return obj. /* note */ value + 1;',
    'return value + 1 /* note */ * 3;']) {
    assert.equal(adaptExpression({ oldText: 'n + 1', newText: 'n * 2', content }).ok, false, content);
  }
});

test('does not equate legacy octal with decimal constants', () => {
  assert.equal(adaptExpression({ oldText: 'n + 10', newText: 'n * 2', content: 'return value + 010;' }).ok, false);
});
