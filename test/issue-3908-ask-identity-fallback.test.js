'use strict';

// #3908: when `ask` could not find the question's subject, it fell back to the
// identity node (`huqan`) and returned that node's edges with `unknown: false`
// -- a confident, unrelated answer. The identity subject is a label for an
// undetected question, not a subject to answer from. A question that really
// names the identity node must still resolve it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');

function makeKernel(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-ask-identity-${label}-`));
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

function seedIdentity(kernel) {
  kernel.graph.addNode('huqan', 'huqan', null, { workspaceId: 'default' });
  kernel.graph.addNode('agent', 'agent', null, { workspaceId: 'default' });
  kernel.graph.addEdge('huqan', 'agent', 'yapabilir', { weight: 0.9, workspaceId: 'default' });
}

test('an unparseable question does not answer from the identity node (#3908)', () => {
  const kernel = makeKernel('unparseable');
  try {
    seedIdentity(kernel);
    for (const question of ['asdfqwer zzz', 'the moon is made of cheese']) {
      const answer = kernel.ask(question);
      assert.equal(answer.data.subject, 'huqan', `${question}: identity is still the reported subject`);
      assert.equal(answer.data.unknown, true, `${question} must be unanswered`);
      assert.equal(answer.data.answer, 'Bilmiyorum', `${question} must not return the identity node's edges`);
    }
  } finally {
    closeKernel(kernel);
  }
});

test('a reason question whose subject normalises away is unanswered (#3908)', () => {
  const kernel = makeKernel('empty-subject');
  try {
    seedIdentity(kernel);
    for (const question of ['neden !!!', 'niçin ???', 'niye ...']) {
      const answer = kernel.ask(question);
      assert.equal(answer.data.unknown, true, `${question} must be unanswered`);
      assert.equal(answer.data.answer, 'Bilmiyorum', `${question} must not return the identity node's edges`);
    }
  } finally {
    closeKernel(kernel);
  }
});

test('a question that names the identity node still resolves it (#3908)', () => {
  const kernel = makeKernel('names-identity');
  try {
    seedIdentity(kernel);
    const answer = kernel.ask('what can huqan do');
    assert.equal(answer.data.subject, 'huqan');
    assert.equal(answer.data.unknown, false, 'a real identity question is answered');
    assert.match(answer.data.answer, /agent/);
  } finally {
    closeKernel(kernel);
  }
});
