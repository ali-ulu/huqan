'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('../kernel');

function kernelWith(lang) {
  return new Kernel({ noLoad: true, loadPlugins: false, ...(lang ? { lang } : {}) });
}

describe('issue #3704: kernel routes extractFacts through the detected language pack', () => {
  it('routes English sentences with leading determiners to the en pack', () => {
    const kernel = kernelWith();
    assert.strictEqual(kernel.lang, 'tr');

    assert.deepStrictEqual(kernel.extractFacts('a cat is a mammal', null), [
      { subject: 'cat', predicate: 'mammal' },
    ]);
    assert.deepStrictEqual(kernel.extractFacts('the sky is blue', null), [
      { subject: 'sky', predicate: 'blue' },
    ]);
    assert.deepStrictEqual(kernel.extractFacts('a closure is a function', null), [
      { subject: 'closure', predicate: 'function' },
    ]);
  });

  it('keeps Turkish sentences on the configured tr pack', () => {
    const kernel = kernelWith();
    assert.deepStrictEqual(kernel.extractFacts('kedi hayvandır', null), [
      { subject: 'kedi', predicate: 'hayvandır' },
    ]);
  });

  it('keeps an explicitly configured en kernel on the en pack', () => {
    const kernel = kernelWith('en');
    assert.deepStrictEqual(kernel.extractFacts('a cat is a mammal', null), [
      { subject: 'cat', predicate: 'mammal' },
    ]);
  });
});
