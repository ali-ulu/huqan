const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-semantic-hardening-'));

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

function seedAviation(kernel) {
  for (const seed of [
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
  ]) {
    kernel.learn(seed, { workspaceId: 'default' });
  }
}

function seedPharma(kernel) {
  for (const seed of [
    'aspirin kan inceltici olarak etki eder',
    'aşı bazı hastalıkları önlemeye yardımcı olabilir',
    'sigara kanser yapar',
  ]) {
    kernel.learn(seed, { workspaceId: 'default' });
  }
}

describe('semantic false-positive hardening', () => {
  it('downgrades aviation false claims away from dogrulandi', () => {
    const kernel = makeKernel('aviation');
    seedAviation(kernel);

    for (const claim of [
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
    ]) {
      const raw = kernel.verify(claim, { workspaceId: 'default' });
      const result = unwrap(raw);

      assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must stay stable');
      assert.notStrictEqual(result.status, 'dogrulandi', `aviation false claim was incorrectly verified: ${claim}`);
      assert.ok(raw.meta && raw.meta.semanticTrust, 'semantic trust metadata should be present');
    }
  });

  it('treats pharma and negation false claims as non-verified', () => {
    const kernel = makeKernel('pharma');
    seedPharma(kernel);

    for (const claim of [
      'aspirin kan pıhtılaştırıcı olarak etki eder',
      'aspirin kan inceltici değildir',
      'aşı tüm hastalıkları önler',
      'sigara her zaman kanser yapar',
    ]) {
      const raw = kernel.verify(claim, { workspaceId: 'default' });
      const result = unwrap(raw);

      assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must stay stable');
      assert.notStrictEqual(result.status, 'dogrulandi', `pharma/negation claim was incorrectly verified: ${claim}`);
    }
  });

  it('keeps value-conflict claims out of verified truth', () => {
    const kernel = makeKernel('value-conflict');
    kernel.learn('EDDF is in Frankfurt', { workspaceId: 'default' });

    const raw = kernel.verify('EDDF is in Paris', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must stay stable');
    assert.notStrictEqual(result.status, 'dogrulandi', 'location conflict must not be verified');
    assert.ok(raw.meta && raw.meta.semanticTrust && raw.meta.semanticTrust.meta.fuzzy, 'fuzzy metadata should be attached');
    assert.strictEqual(raw.meta.semanticTrust.meta.fuzzy.isWeak, true);
  });

  it('stays main-safe on adversarial regression smoke', () => {
    const kernel = makeKernel('adversarial');
    seedAviation(kernel);
    seedPharma(kernel);

    for (const claim of [
      'B737 has 4 engines',
      'EDDF is in Paris',
      'TCAS is weather radar',
      'Mayday is urgency call',
      'aspirin kan pıhtılaştırıcı olarak etki eder',
      'sigara her zaman kanser yapar',
    ]) {
      const result = unwrap(kernel.verify(claim, { workspaceId: 'default' }));
      assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must stay stable');
      assert.notStrictEqual(result.status, 'dogrulandi', `adversarial claim was incorrectly verified: ${claim}`);
    }
  });
});
