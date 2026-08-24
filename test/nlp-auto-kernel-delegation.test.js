'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('../kernel');

test('Kernel auto mode applies language-specific stop-word filters (#1115)', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false, lang: 'auto' });
  try {
    for (const word of ['the', 'is', 'are', 'of', 'and', 'with']) assert.equal(kernel.isStopWord(word), true, word);
    for (const word of ['der', 'die', 'das', 'und']) assert.equal(kernel.isStopWord(word), true, word);
    for (const word of ['في', 'من', 'على']) assert.equal(kernel.isStopWord(word), true, word);
  } finally {
    kernel.graph.close();
    kernel.memory.close();
  }
});
