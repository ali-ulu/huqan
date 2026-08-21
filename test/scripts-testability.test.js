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
  
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(memoryPath)) fs.unlinkSync(memoryPath);
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
