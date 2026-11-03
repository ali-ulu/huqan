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

test('rendered programs preserve native join conversion of nullish elements', () => {
  const input = ['GET', 'GET', null, undefined, 'POST'];
  const join = vm.runInNewContext(`(function(value){${renderStringArrayProgram({ type: 'join', separator: ',' })}})`);
  const unique = vm.runInNewContext(`(function(value){${renderStringArrayProgram({ type: 'stableUniqueJoin', separator: ',' })}})`);
  assert.equal(join(input), 'GET,GET,,,POST');
  assert.equal(unique(input), 'GET,,,POST');
  assert.equal(validStringArray(input), false);
});

test('rendered programs read each element and the length exactly once, like native join', () => {
  const render = (type) => vm.runInNewContext(`(function(value){${renderStringArrayProgram({ type, separator: ',' })}})`);
  for (const type of ['join', 'stableUniqueJoin']) {
    let lengthReads = 0; const elementReads = [];
    const arr = {};
    Object.defineProperty(arr, 'length', { get() { lengthReads += 1; return 3; } });
    for (let i = 0; i < 3; i += 1) {
      Object.defineProperty(arr, String(i), {
        enumerable: true,
        get() { elementReads.push(i); return ['a', 'b', 'a'][i]; },
      });
    }
    assert.equal(render(type)(arr), type === 'join' ? 'a,b,a' : 'a,b');
    assert.deepEqual(elementReads, [0, 1, 2], `${type} must read each element once, in order`);
    assert.equal(lengthReads, 1, `${type} must read the length once`);
  }
});
