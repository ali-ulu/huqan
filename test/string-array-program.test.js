'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { validStringArray, validateStringArrayProgram, evaluateStringArrayProgram,
  renderStringArrayProgram, searchStringArrayPrograms } = require('../lib/experience/string-array-program');

test('bounded string arrays reject holes, accessors, proxies and extra fields without invoking getters', () => {
  assert.equal(validStringArray(['', '__proto__', '😀']), true);
  const hole = Array(1); assert.equal(validStringArray(hole), false);
  let invoked = false; const accessor = [];
  Object.defineProperty(accessor, '0', { get() { invoked = true; return 'x'; }, enumerable: true });
  assert.equal(validStringArray(accessor), false); assert.equal(invoked, false);
  assert.equal(validStringArray(new Proxy([], {})), false);
  const extra = []; extra.foo = 1; assert.equal(validStringArray(extra), false);
  assert.equal(validStringArray(Array(129).fill('x')), false);
  assert.equal(validStringArray([1]), false);
  assert.equal(validStringArray(['x'.repeat(1025)]), false);
});

test('both programs agree with rendered ES5 expressions even when builtins are shadowed', () => {
  for (const type of ['join', 'stableUniqueJoin']) {
    const program = { type, separator: '\u2028|\u2029' };
    assert.equal(validateStringArrayProgram(program), true);
    for (const input of [[], ['', ''], ['__proto__', '😀', '__proto__', '']]) {
      const code = `(function(value, Set, Array) { ${renderStringArrayProgram(program)} })`;
      const rendered = vm.runInNewContext(code)(input, null, null);
      assert.equal(rendered, evaluateStringArrayProgram(program, input));
    }
  }
  assert.equal(evaluateStringArrayProgram({type:'stableUniqueJoin', separator:','}, ['a','b','a']), 'a,b');
});

test('program validation rejects unsafe records and search fails closed on ambiguity or contradiction', () => {
  assert.equal(validateStringArrayProgram(new Proxy({type:'join', separator:','}, {})), false);
  let invoked = false;
  const getter = { type: 'join', get separator() { invoked = true; return ','; } };
  assert.equal(validateStringArrayProgram(getter), false);
  assert.equal(invoked, false);
  assert.equal(validateStringArrayProgram({type:'join', separator:',', extra:true}), false);
  for (const parameter of ['for', 'return', 'a.b', 'x;throw 1'])
    assert.throws(() => renderStringArrayProgram({type:'join', separator:','}, parameter), TypeError);
  const examples = [{input: ['a','a'], output:'a'}, {input: [], output:''}];
  const result = searchStringArrayPrograms(examples, ',');
  assert.equal(result.enumerated, 2); assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].program.type, 'stableUniqueJoin');
  const ambiguous = searchStringArrayPrograms([{input:['a'], output:'a'}], ',');
  assert.equal(ambiguous.enumerated, 2); assert.equal(ambiguous.matchingPrograms, 2);
  assert.equal(ambiguous.candidates.length, 0);
  const contradictory = searchStringArrayPrograms([{input:['a'], output:'b'}], ',');
  assert.equal(contradictory.enumerated, 2); assert.equal(contradictory.matchingPrograms, 0);
  assert.equal(contradictory.candidates.length, 0);
});
