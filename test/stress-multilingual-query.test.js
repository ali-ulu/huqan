const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-stress-multilingual-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${name}.json`),
    dbPath: path.join(tempDir, `${name}.db`),
  });

  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

function unwrap(result) {
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') {
    return result.data;
  }
  return result;
}

function withMutedConsole(fn) {
  const originalLog = console.log;
  const originalInfo = console.info;
  console.log = () => {};
  console.info = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
}

describe('Stress Multilingual Query Regression', () => {
  const seeds = [
    'B737 is aircraft',
    'B737 has 2 engines',
    'A380 is aircraft',
    'C172 is aircraft',
  ];

  const queries = [
    'was ist B737',
    'Flugzeug B737',
    'avion B737',
    'uçak B737',
    'B737 nedir',
    'what is B737',
  ];

  it('does not promote weak multilingual overlap to verified truth', () => {
    const kernel = makeKernel('multilingual');
    withMutedConsole(() => {
      for (const seed of seeds) {
        kernel.learn(seed, { workspaceId: 'default' });
      }
    });

    for (const query of queries) {
      const result = unwrap(kernel.verify(query, { workspaceId: 'default' }));
      assert.ok(result && typeof result === 'object', 'verify result should be an object');
      assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must stay stable');
      assert.notStrictEqual(
        result.status,
        'dogrulandi',
        `weak multilingual query was incorrectly verified: ${query}`,
      );
    }
  });

  it('does not verify a multilingual false claim', () => {
    const kernel = makeKernel('multilingual-negative');
    withMutedConsole(() => {
      for (const seed of seeds) {
        kernel.learn(seed, { workspaceId: 'default' });
      }
    });

    const result = unwrap(kernel.verify('B737 has 4 engines', { workspaceId: 'default' }));

    assert.ok(result && typeof result === 'object', 'verify result should be an object');
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must stay stable');
    assert.notStrictEqual(result.status, 'dogrulandi', 'false multilingual claim must not be verified');
  });
});
