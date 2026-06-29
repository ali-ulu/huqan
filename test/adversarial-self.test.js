const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-adversarial-self-'));
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
  return result && typeof result === 'object' && result.data && typeof result.data === 'object'
    ? result.data
    : result;
}

function seed(kernel) {
  for (const statement of [
    'B737 is aircraft',
    'B737 has 2 engines',
    'EDDF is in Frankfurt',
    'TCAS detects traffic',
    'aspirin kan inceltici olarak etki eder',
    'sigara kanser yapar',
  ]) {
    kernel.learn(statement, { workspaceId: 'default', ...TEST_FIXTURE_LEARN_BYPASS });
  }
}

describe('adversarial self test', () => {
  const runKnownFailing = process.env.AXIOM_RUN_KNOWN_FAILING_REGRESSIONS === '1';
  const knownFailingIt = runKnownFailing ? it : it.skip;

  it('keeps false claims out of verified truth and exposes downgrade metadata', () => {
    const kernel = makeKernel('false-claim');
    seed(kernel);

    const claims = [
      'B737 has 4 engines',
      'EDDF is in Paris',
      'TCAS is weather radar',
      'aspirin kan pıhtılaştırıcı olarak etki eder',
      'sigara her zaman kanser yapar',
    ];

    for (const claim of claims) {
      const raw = kernel.verify(claim, { workspaceId: 'default' });
      const result = unwrap(raw);

      assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status));
      assert.notStrictEqual(result.status, 'dogrulandi');
      assert.ok(raw.meta && raw.meta.semanticTrust, 'semantic trust metadata should be present');
      assert.ok(Array.isArray(raw.meta.semanticTrust.warnings));
      assert.ok(Array.isArray(raw.meta.reasoningTrace.steps));
    }
  });

  it('keeps unsupported claims downgraded', () => {
    const kernel = makeKernel('unsupported');
    seed(kernel);

    const raw = kernel.verify('Ali dedi ki B737 has 4 engines', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status));
    assert.notStrictEqual(result.status, 'dogrulandi');
    assert.ok(raw.meta.semanticTrust.warnings.includes('STRAWMAN_ATTRIBUTION') || raw.meta.semanticTrust.warnings.includes('WEASEL_WORDS'));
  });

  knownFailingIt('TODO(v0.9-semantic-gate): weak partial match still downgrades incorrectly today', () => {
    const kernel = makeKernel('weak-partial');
    seed(kernel);

    const raw = kernel.verify('B737 has engines', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status));
    assert.strictEqual(result.status, 'bilinmiyor');
    assert.ok(raw.meta.semanticTrust.matchType === 'partial_match' || raw.meta.semanticTrust.matchType === 'unknown');
  });
});
