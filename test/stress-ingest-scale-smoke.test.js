const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-stress-ingest-'));
const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

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

describe('Stress Ingest Scale Smoke', () => {
  it('ingests a deterministic medium-sized batch without throwing', () => {
    const kernel = makeKernel('ingest-scale');
    const before = kernel.graph.getStats();

    withMutedConsole(() => {
      for (let i = 1; i <= 250; i++) {
        const id = String(i).padStart(4, '0');
        kernel.learn(`Aircraft_${id} is aircraft`, { workspaceId: 'default', ...TEST_FIXTURE_LEARN_BYPASS });
        kernel.learn(`Aircraft_${id} has 2 engines`, { workspaceId: 'default', ...TEST_FIXTURE_LEARN_BYPASS });
        kernel.learn(`Airport_${id} is in City_${id}`, { workspaceId: 'default', ...TEST_FIXTURE_LEARN_BYPASS });
      }
    });

    const after = kernel.graph.getStats();
    assert.ok(after.nodes > before.nodes, 'node count should increase after ingest');
    assert.ok(after.edges > before.edges, 'edge count should increase after ingest');

    const verifyResult = unwrap(kernel.verify('Aircraft_0100 has 4 engines', { workspaceId: 'default' }));
    assert.ok(verifyResult && typeof verifyResult === 'object', 'verify result should be an object');
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(verifyResult.status), 'status contract must stay stable');
    assert.notStrictEqual(verifyResult.status, 'dogrulandi', 'post-ingest false claim must not be verified');
  });
});
