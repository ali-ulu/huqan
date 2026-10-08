'use strict';

// #3639: `ask` detected the subject from the first word of the question and
// stripped only Turkish interrogatives. An English question ("ask: what is a
// cat") kept `what` as its first word, missed the node lookup, and answered
// from the identity fallback -- even though `cat` was in the graph. The English
// question words, articles and copula are now stripped too, and a subject the
// lead word misses is searched for across the question.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');

function makeKernel(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-ask-english-${label}-`));
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
}

function closeKernel(kernel) {
  kernel.graph.close();
  kernel.memory.close();
}

test('an English question resolves the known subject, not the identity fallback', () => {
  const kernel = makeKernel('what-is');
  try {
    kernel.graph.addNode('cat', 'cat', null, { workspaceId: 'default' });
    kernel.graph.addNode('animal', 'animal', null, { workspaceId: 'default' });
    kernel.graph.addEdge('cat', 'animal', 'tür', { weight: 0.9, workspaceId: 'default' });

    for (const question of ['what is a cat', 'what is cat']) {
      const answer = kernel.ask(question);
      assert.equal(answer.data.subject, 'cat', `${question} must resolve to cat`);
      assert.equal(answer.data.unknown, false, `${question} must be answered`);
      assert.match(answer.data.answer, /animal/, `${question} must carry cat's edge`);
    }
  } finally {
    closeKernel(kernel);
  }
});

test('a subject the lead word misses is found later in the question', () => {
  const kernel = makeKernel('mid-subject');
  try {
    kernel.graph.addNode('cat', 'cat', null, { workspaceId: 'default' });
    kernel.graph.addNode('animal', 'animal', null, { workspaceId: 'default' });
    kernel.graph.addEdge('cat', 'animal', 'tür', { weight: 0.9, workspaceId: 'default' });

    // `tell` is not a node; the lead-word lookup misses and the scan must find
    // `cat` instead of falling to the identity subject.
    const answer = kernel.ask('tell me about cat');
    assert.equal(answer.data.subject, 'cat');
    assert.equal(answer.data.unknown, false);
  } finally {
    closeKernel(kernel);
  }
});

test('a question with no known subject still falls back to the identity subject', () => {
  const kernel = makeKernel('no-subject');
  try {
    kernel.graph.addNode('cat', 'cat', null, { workspaceId: 'default' });
    const answer = kernel.ask('what is a zebra');
    assert.equal(answer.data.subject, 'huqan');
    assert.equal(answer.data.unknown, true);
  } finally {
    closeKernel(kernel);
  }
});

test('Turkish questions keep answering as before', () => {
  const kernel = makeKernel('turkish');
  try {
    kernel.graph.addNode('dog', 'dog', null, { workspaceId: 'default' });
    kernel.graph.addNode('mammal', 'mammal', null, { workspaceId: 'default' });
    kernel.graph.addEdge('dog', 'mammal', 'tür', { weight: 0.9, workspaceId: 'default' });

    const answer = kernel.ask('dog nedir');
    assert.equal(answer.data.subject, 'dog');
    assert.equal(answer.data.unknown, false);
  } finally {
    closeKernel(kernel);
  }
});
