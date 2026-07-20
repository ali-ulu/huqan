'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');

function makeKernel(label, overrides = {}) {
  const root = path.join(os.tmpdir(), `huqan-read-use-cases-${process.pid}-${label}`);
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
    ...overrides,
  });
}

function closeKernel(kernel) {
  kernel.graph.close();
  kernel.memory.close();
}

test('Kernel delegates entropy and gap inspection through read use cases', () => {
  const kernel = makeKernel('delegation');
  const calls = [];
  const originalAsk = kernel._readUseCases.ask;
  const originalGetPersistenceDescriptor = kernel._readUseCases.getPersistenceDescriptor;
  const originalEntropy = kernel._readUseCases.entropy;
  const originalDetectGaps = kernel._readUseCases.detectGaps;
  const originalReason = kernel._readUseCases.reason;
  const originalCompare = kernel._readUseCases.compare;

  kernel._readUseCases = {
    ask(question) {
      calls.push(['ask', question]);
      return originalAsk(question);
    },
    getPersistenceDescriptor() {
      calls.push(['getPersistenceDescriptor']);
      return originalGetPersistenceDescriptor();
    },
    entropy(workspaceId) {
      calls.push(['entropy', workspaceId]);
      return originalEntropy(workspaceId);
    },
    detectGaps(workspaceId) {
      calls.push(['detectGaps', workspaceId]);
      return originalDetectGaps(workspaceId);
    },
    reason(subject, workspaceId) {
      calls.push(['reason', subject, workspaceId]);
      return originalReason(subject, workspaceId);
    },
    compare(a, b, workspaceId) {
      calls.push(['compare', a, b, workspaceId]);
      return originalCompare(a, b, workspaceId);
    },
  };

  try {
    assert.equal(kernel.ask('bilinmeyen nedir').type, 'ask');
    assert.equal(kernel.getPersistenceDescriptor().memoryPath.endsWith('memory.json'), true);
    assert.equal(kernel.entropy('workspace-a'), 0);
    assert.deepEqual(kernel.detectGaps('workspace-a'), []);
    assert.equal(kernel.reason('subject-a', 'workspace-a').type, 'reason');
    assert.equal(kernel.compare('subject-a', 'subject-b', 'workspace-a').type, 'compare');
    assert.deepEqual(calls, [
      ['ask', 'bilinmeyen nedir'],
      ['getPersistenceDescriptor'],
      ['entropy', 'workspace-a'],
      ['detectGaps', 'workspace-a'],
      ['reason', 'subject-a', 'workspace-a'],
      ['compare', 'subject-a', 'subject-b', 'workspace-a'],
    ]);
  } finally {
    closeKernel(kernel);
  }
});

test('read use cases preserve persistence descriptor observable results', () => {
  const root = path.join(os.tmpdir(), `huqan-read-use-cases-${process.pid}-persistence-descriptor`);
  const kernel = makeKernel('persistence-descriptor', {
    dbPath: path.join(root, 'independent.db'),
  });

  try {
    const descriptor = kernel.getPersistenceDescriptor();

    assert.deepEqual(descriptor, {
      memoryPath: path.join(root, 'memory.json'),
      dbPath: path.join(root, 'memory.db'),
    });
    assert.equal(Object.isFrozen(descriptor), true);
  } finally {
    closeKernel(kernel);
  }
});

test('read use cases preserve entropy and detectGaps observable results', () => {
  const kernel = makeKernel('parity');

  try {
    kernel.graph.addNode('a', 'a', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('b', 'b', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('c', 'c', null, { workspaceId: 'workspace-a' });
    kernel.graph.addEdge('a', 'b', 'related', { weight: 0.25, workspaceId: 'workspace-a' });
    kernel.graph.addEdge('a', 'c', 'related', { weight: 0.75, workspaceId: 'workspace-a' });

    const expectedEntropy = -((0.25 / 1) * Math.log(0.25 / 1)) - ((0.75 / 1) * Math.log(0.75 / 1));

    assert.equal(kernel.entropy('workspace-a'), expectedEntropy);
    assert.deepEqual(kernel.detectGaps('workspace-a'), ['b', 'c']);
    assert.equal(kernel.entropy('workspace-b'), 0);
    assert.deepEqual(kernel.detectGaps('workspace-b'), []);
  } finally {
    closeKernel(kernel);
  }
});

test('read use cases preserve reason and compare observable results', () => {
  const kernel = makeKernel('reason-compare');

  try {
    kernel.graph.addNode('dog', 'dog', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('cat', 'cat', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('animal', 'animal', null, { workspaceId: 'workspace-a' });
    kernel.graph.addNode('friend', 'friend', null, { workspaceId: 'workspace-a' });
    kernel.graph.addEdge('dog', 'animal', 'is_a', { weight: 0.9, workspaceId: 'workspace-a' });
    kernel.graph.addEdge('cat', 'animal', 'is_a', { weight: 0.8, workspaceId: 'workspace-a' });
    kernel.graph.addEdge('dog', 'friend', 'related', { weight: 0.5, workspaceId: 'workspace-a' });

    const reason = kernel.reason('dog', 'workspace-a');
    assert.equal(reason.type, 'reason');
    assert.equal(reason.data.subject, 'dog');
    assert.match(reason.data.answer, /dog:/);
    assert.deepEqual(reason.data.forward.map(edge => [edge.from, edge.to, edge.relation]), [
      ['dog', 'animal', 'is_a'],
      ['dog', 'friend', 'related'],
    ]);
    assert.ok(Array.isArray(reason.data.backward));
    assert.ok(Array.isArray(reason.data.cycles));
    assert.ok(reason.evidence.length >= 2);

    const compare = kernel.compare('dog', 'cat', 'workspace-a');
    assert.equal(compare.type, 'compare');
    assert.equal(compare.data.a, 'dog');
    assert.equal(compare.data.b, 'cat');
    assert.deepEqual(compare.data.common.map(edge => [edge.to, edge.relation]), [
      ['animal', 'is_a'],
    ]);
    assert.deepEqual(compare.data.onlyA.map(edge => [edge.to, edge.relation]), [
      ['friend', 'related'],
    ]);
    assert.deepEqual(compare.data.onlyB, []);
    assert.ok(compare.evidence.length >= 2);

    const unknown = kernel.compare('dog', 'missing', 'workspace-a');
    assert.deepEqual(unknown.data, {
      a: 'dog',
      b: 'missing',
      answer: 'Bilmiyorum',
      common: [],
      onlyA: [],
      onlyB: [],
      paths: [],
    });
  } finally {
    closeKernel(kernel);
  }
});

test('read use cases preserve ask observable results', () => {
  const kernel = makeKernel('ask');

  try {
    kernel.graph.addNode('dog', 'dog', null, { workspaceId: 'default' });
    kernel.graph.addNode('mammal', 'mammal', null, { workspaceId: 'default' });
    kernel.graph.addNode('animal', 'animal', null, { workspaceId: 'default' });
    kernel.graph.addNode('friend', 'friend', null, { workspaceId: 'default' });
    kernel.graph.addEdge('dog', 'mammal', 'tür', { weight: 0.9, workspaceId: 'default' });
    kernel.graph.addEdge('mammal', 'animal', 'tür', { weight: 0.8, workspaceId: 'default' });
    kernel.graph.addEdge('dog', 'friend', 'yapabilir', { weight: 0.5, workspaceId: 'default' });

    const answer = kernel.ask('dog nedir');
    assert.equal(answer.type, 'ask');
    assert.equal(answer.data.subject, 'dog');
    assert.equal(answer.data.unknown, false);
    assert.match(answer.data.answer, /dog/);
    assert.match(answer.data.answer, /mammal/);
    assert.match(answer.data.answer, /animal/);
    assert.match(answer.data.answer, /friend/);
    assert.ok(answer.evidence.length >= 2);

    const unknown = kernel.ask('missing nedir');
    assert.deepEqual(unknown.data, {
      answer: 'Bilmiyorum',
      subject: 'axiom',
      unknown: true,
    });

    const why = kernel.ask('neden dog');
    assert.equal(why.type, 'reason');
    assert.equal(why.data.subject, 'dog');
  } finally {
    closeKernel(kernel);
  }
});
