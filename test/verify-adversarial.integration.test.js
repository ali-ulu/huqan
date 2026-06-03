const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-verify-adversarial-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${name}.json`),
  });

  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

describe('verify adversarial integration', () => {
  it('surfaces double negation as a risk signal without changing core status', () => {
    const kernel = makeKernel('double-negation');
    const raw = kernel.verify('B737 is not not aircraft', { workspaceId: 'default' });

    assert.ok(raw && typeof raw === 'object');
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(raw.data.status));
    assert.ok(raw.meta.semanticTrust.warnings.includes('DOUBLE_NEGATION'));
  });

  it('surfaces weasel words and alias normalization as secondary metadata', () => {
    const kernel = makeKernel('weasel-alias');
    const raw = kernel.verify('RN is React Native', { workspaceId: 'default' });

    assert.ok(raw && typeof raw === 'object');
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(raw.data.status));
    assert.ok(raw.meta.semanticTrust.warnings.includes('ALIAS_NORMALIZATION'));

    const weasel = kernel.verify('aspirin genellikle güvenlidir', { workspaceId: 'default' });
    assert.ok(weasel.meta.semanticTrust.warnings.includes('WEASEL_WORDS'));
  });

  it('surfaces strawman attribution framing as risk metadata', () => {
    const kernel = makeKernel('strawman');
    const raw = kernel.verify('Ali dedi ki B737 has 4 engines', { workspaceId: 'default' });

    assert.ok(raw && typeof raw === 'object');
    assert.ok(raw.meta.semanticTrust.warnings.includes('STRAWMAN_ATTRIBUTION'));
  });
});
