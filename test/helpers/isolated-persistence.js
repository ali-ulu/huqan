'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const roots = new Set();

function createIsolatedPersistenceRoot(label = 'kernel') {
  const safeLabel = String(label).replace(/[^a-z0-9_-]+/gi, '-');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-test-${safeLabel}-${process.pid}-`));
  roots.add(root);
  return root;
}

function isolatedKernelOptions(label = 'kernel', overrides = {}) {
  const root = createIsolatedPersistenceRoot(label);
  return {
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: null,
    ...overrides,
  };
}

function isolatedGraphOptions(label = 'graph', overrides = {}) {
  const root = createIsolatedPersistenceRoot(label);
  return {
    useSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: null,
    ...overrides,
  };
}

function cleanupRoots() {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_) {
      // Test cleanup must not turn an already-completed assertion into a failure.
    }
  }
  roots.clear();
}

process.once('exit', cleanupRoots);

module.exports = {
  createIsolatedPersistenceRoot,
  isolatedKernelOptions,
  isolatedGraphOptions,
};
