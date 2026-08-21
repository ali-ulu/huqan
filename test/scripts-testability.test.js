'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createKernel,
  addFact,
  seedFacts,
  runDemoSeed
} = require('../scripts/seed-demo.js');

const {
  commandLabel,
  verifySqlite,
  setupSqlite
} = require('../scripts/setup-sqlite.js');

test('seed-demo exports functions', (t) => {
  assert.equal(typeof createKernel, 'function');
  assert.equal(typeof addFact, 'function');
  assert.equal(typeof seedFacts, 'function');
  assert.equal(typeof runDemoSeed, 'function');
});

test('seed-demo runDemoSeed works', (t) => {
  const dbPath = path.join(__dirname, 'test-demo-seed.db');
  const memoryPath = path.join(__dirname, 'test-demo-seed.json');
  
  const result = runDemoSeed({ dbPath, memoryPath, silent: true });
  assert.ok(result.nodeCount > 0);
  assert.ok(result.edgeCount > 0);
  
  // SQLite writes `-shm`/`-wal` sidecars beside the database, and the kernel
  // writes an `.embeddings.json` beside the memory file. Removing only the two
  // paths passed in left three files behind in test/ on every run.
  for (const leftover of [
    dbPath,
    `${dbPath}-shm`,
    `${dbPath}-wal`,
    memoryPath,
    memoryPath.replace(/\.json$/, '.embeddings.json'),
  ]) {
    if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
  }
});

test('setup-sqlite commandLabel', (t) => {
  const label = commandLabel(['ci']);
  assert.ok(label.includes('npm'));
  assert.ok(label.includes('ci'));
});

test('setup-sqlite verifySqlite returns boolean', (t) => {
  const result = verifySqlite();
  assert.equal(typeof result, 'boolean');
});
