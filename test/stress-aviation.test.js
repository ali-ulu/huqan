const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-stress-aviation-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name, useSQLite = false) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite,
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

describe('Stress Aviation Regression', () => {
  const seeds = [
    'B737 is aircraft',
    'B737 has 2 engines',
    'A380 is widebody aircraft',
    'A380 has 4 engines',
    'C172 is piston aircraft',
    'EDDF is in Frankfurt',
    'squawk 7700 means emergency',
    'squawk 7600 means radio failure',
    'Mayday is distress call',
    'Pan-Pan is urgency call',
    'ISA sea level temperature is 15 celsius',
    'FAR Part 25 is transport category',
    'TCAS detects traffic',
    'V1 is decision speed',
    'VR is rotation speed',
  ];

  const falseClaims = [
    'B737 has 4 engines',
    'A380 is regional aircraft',
    'C172 is jet aircraft',
    'EDDF is in Paris',
    'squawk 7700 is radio failure',
    'Mayday is urgency call',
    'Pan-Pan is distress call',
    'ISA sea level temperature is 0 celsius',
    'FAR Part 25 is normal category',
    'TCAS is weather radar',
    'V1 is rotation speed',
    'VR is decision speed',
  ];

  const runKnownFailing = process.env.AXIOM_RUN_KNOWN_FAILING_REGRESSIONS === '1';
  const knownFailingIt = runKnownFailing ? it : it.skip;

  it('keeps aviation seed facts valid and status contract stable', () => {
    const kernel = makeKernel('aviation-smoke');
    withMutedConsole(() => {
      for (const seed of seeds) {
        kernel.learn(seed, { workspaceId: 'default' });
      }
    });

    const result = unwrap(kernel.verify('B737 has 2 engines', { workspaceId: 'default' }));
    assert.ok(result && typeof result === 'object', 'verify result should be an object');
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must stay stable');
    assert.strictEqual(result.status, 'dogrulandi', 'seed fact should remain verified');
  });

  for (const [index, claim] of falseClaims.entries()) {
    knownFailingIt(`TODO(v0.9-semantic-gate): aviation false claim #${index + 1} stays false-positive today: ${claim}`, () => {
      const kernel = makeKernel(`aviation-${index + 1}`);
      withMutedConsole(() => {
        for (const seed of seeds) {
          kernel.learn(seed, { workspaceId: 'default' });
        }
      });

      const result = unwrap(kernel.verify(claim, { workspaceId: 'default' }));

      assert.ok(result && typeof result === 'object', 'verify result should be an object');
      assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must stay stable');
      assert.notStrictEqual(
        result.status,
        'dogrulandi',
        `aviation false claim was incorrectly verified: ${claim}`,
      );

      if (result.classification !== undefined) {
        assert.notStrictEqual(result.classification, 'dogrulandi', 'classification must not replace core status');
      }
    });
  }
});
