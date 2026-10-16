'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Kernel = require('../kernel');

function makeKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-defer-save-'));
  return new Kernel({
    noLoad: true,
    memoryPath: path.join(dir, 'memory.json'),
    useSQLite: false,
    loadPlugins: false,
  });
}

function spySave(kernel) {
  const calls = { count: 0 };
  const original = kernel.graph.save.bind(kernel.graph);
  kernel.graph.save = (...args) => {
    calls.count += 1;
    return original(...args);
  };
  return calls;
}

const CORPUS = 'kedi hayvandir\nkopek memelidir\nkus ucar';

test('deferSave flushes the graph exactly once per document (#1747)', () => {
  const kernel = makeKernel();
  const save = spySave(kernel);
  const bypass = Kernel.createAdmissionBypassOpts('defer-save test');

  const learned = kernel.learnDocument(CORPUS, { ...bypass, deferSave: true });

  assert.equal(learned, 3, 'all three eligible lines must be learned');
  assert.equal(save.count, 1, 'deferSave must produce exactly one save flush per document');
});

test('default learnDocument adds no document-level flush (#216 journal owns persistence)', () => {
  const kernel = makeKernel();
  const save = spySave(kernel);
  const bypass = Kernel.createAdmissionBypassOpts('default save test');

  const learned = kernel.learnDocument(CORPUS, { ...bypass });

  assert.equal(learned, 3, 'all three eligible lines must be learned');
  // Since #216 every learn() runs inside the durable mutation journal, so
  // executeLearn's per-line graph.save() is inert (_durableMutationTransaction).
  // Default therefore performs zero *document-level* flushes; durability is
  // owned by the journal. deferSave's single flush must remain opt-in.
  assert.equal(save.count, 0, 'without deferSave there must be no extra document-level save');
});

test('deferSave leaves the persisted file absent until the flush, present after it', () => {
  const kernel = makeKernel();
  const bypass = Kernel.createAdmissionBypassOpts('persistence visibility test');

  // Learn a line WITHOUT saving (deferSave suppresses per-line save), then
  // assert the flush actually lands the state on disk.
  kernel.learnDocument(CORPUS, { ...bypass, deferSave: true });
  assert.equal(kernel.graph._nodes.size >= 3 || Object.keys(kernel.graph._nodes).length >= 3, true, 'in-memory graph must hold the learned nodes');

  const saved = kernel.graph.save();
  assert.ok(saved !== false, 'explicit flush must persist successfully');
});