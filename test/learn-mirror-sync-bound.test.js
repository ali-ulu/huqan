'use strict';

// #3037: single-fact learn() must not full-save per fact on the shipped
// default (SQLite) store. Every learn commits state plus journal in one DB
// transaction (already durable); the per-learn graph.save() only rewrote the
// JSON fallback export, O(n) bytes per fact. The mirror sync is now bounded
// (every 100 learns or 60 s); these tests pin that contract and prove the
// deferred mirror loses nothing: a close/reopen without save still sees
// every fact, because SQLite is the record authority.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Kernel = require('../kernel');

function makePaths(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-mirror-sync-${tag}-`));
  return { dir, memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') };
}

// Default store: useSQLite unset, so the shipped default (SQLite when
// available) is exercised, not the bench-only JSON stub.
function makeKernel(paths) {
  return new Kernel({
    noLoad: true,
    memoryPath: paths.memoryPath,
    dbPath: paths.dbPath,
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

function fact(i) {
  return `olcek-${i} kavramdir`;
}

test('single-fact learn() performs no per-learn save on the default store (#3037)', () => {
  const paths = makePaths('no-per-learn-save');
  const kernel = makeKernel(paths);
  const save = spySave(kernel);
  const bypass = Kernel.createAdmissionBypassOpts('mirror sync test');

  for (let i = 0; i < 5; i += 1) kernel.learn(fact(i), bypass);
  assert.ok(save.count <= 1, `5 learns must sync the mirror at most once, got ${save.count}`);

  for (let i = 5; i < 10; i += 1) kernel.learn(fact(i), bypass);
  assert.ok(save.count <= 1, `10 learns must still sync at most once, got ${save.count}`);
});

test('learned facts survive close/reopen without an explicit save (#3037)', () => {
  const paths = makePaths('durable-reopen');
  const kernel = makeKernel(paths);
  const bypass = Kernel.createAdmissionBypassOpts('durable reopen test');

  for (let i = 0; i < 5; i += 1) kernel.learn(fact(i), bypass);
  kernel.graph.close();

  const reopened = new Kernel({
    memoryPath: paths.memoryPath,
    dbPath: paths.dbPath,
    loadPlugins: false,
  });
  try {
    assert.ok(Object.keys(reopened.graph._nodes).length >= 5, 'reopened graph must hold the learned nodes');
    const verdict = reopened.verify(fact(0));
    assert.equal(verdict?.data?.status, 'verified', 'a learned fact must verify after reopen with no explicit save');
  } finally {
    reopened.graph.close();
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test('write bytes per learn stay flat as the graph grows (#3037)', () => {
  const paths = makePaths('bytes-flat');
  const kernel = makeKernel(paths);
  const bypass = Kernel.createAdmissionBypassOpts('bytes flat test');

  const countBytes = (count, start) => {
    let bytes = 0;
    const original = fs.writeFileSync;
    fs.writeFileSync = function (file, data, options) {
      try {
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        bytes += Buffer.byteLength(text);
      } catch (_) { /* size accounting only */ }
      return original.call(fs, file, data, options);
    };
    try {
      for (let i = start; i < start + count; i += 1) kernel.learn(fact(i), bypass);
    } finally {
      fs.writeFileSync = original;
    }
    return bytes;
  };

  const firstBatch = countBytes(20, 0);
  const secondBatch = countBytes(20, 20);
  // Pre-fix this ratio is ~4x (full export rewrite per fact, quadratic
  // total); post-fix the second batch writes no mirror at all.
  assert.ok(secondBatch <= firstBatch, `second batch bytes (${secondBatch}) must not exceed first batch (${firstBatch})`);
});

test('mirror sync is bounded: the count threshold flushes (#3037)', () => {
  const paths = makePaths('threshold-flush');
  const kernel = makeKernel(paths);
  const save = spySave(kernel);
  const bypass = Kernel.createAdmissionBypassOpts('threshold flush test');

  for (let i = 0; i < 110; i += 1) kernel.learn(fact(i), bypass);
  // One sync on the first learn (cold mirror), one at the 100-learn mark.
  // Pre-fix this is 110; an unbounded deferral would be 0 after the first.
  assert.equal(save.count, 2, `110 learns must sync the mirror exactly twice, got ${save.count}`);
});
