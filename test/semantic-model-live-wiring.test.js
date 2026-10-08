'use strict';

// R51 PR3 (#3583): the own-weight model on the live path. `off` must leave the
// rules-only outputs byte-identical; `shadow` must report the model (with its
// artifact digest, in the verify meta and the receipt preview) while every
// decision stays exactly what the rules decided.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const { runSemanticSignals } = require('../lib/semantic-signals');
const { buildVerifySemanticTrust } = require('../lib/verify-native');
const { registerSemanticModelProvider, clearSemanticModelProvider } = require('../lib/semantic-model-port');
const { createSemanticModelProvider } = require('../lib/semantic-model-provider');

const SSM_DIGEST = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'semantic-model-artifacts', 'ssm.json'), 'utf8')).artifactDigest;
const STORED = { text: 'coffee is a stimulant', subject: 'coffee' };
const INCOMING = { text: 'coffee is not a stimulant', subject: 'coffee' };
const VERIFY_INPUT = {
  statement: 'kahve sakinleştiricidir',
  result: { status: 'unknown', confidence: 0.2 },
  evidence: [],
  subject: 'kahve',
  predicate: 'sakinleştirici',
  edges: [{ from: 'kahve', relation: 'IS_NOT', to: 'sakinleştirici' }, { from: 'kahve', relation: 'IS', to: 'uyarıcı' }],
};

function withMode(mode, fn) {
  const previous = process.env.HUQAN_SEMANTIC_MODEL;
  process.env.HUQAN_SEMANTIC_MODEL = mode;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.HUQAN_SEMANTIC_MODEL;
    else process.env.HUQAN_SEMANTIC_MODEL = previous;
  }
}

test.beforeEach(() => registerSemanticModelProvider(createSemanticModelProvider({ env: {} })));
test.afterEach(() => clearSemanticModelProvider());

test('runSemanticSignals: off is byte-identical to the unwired rules-only result', () => {
  const offResult = withMode('off', () => runSemanticSignals(STORED, INCOMING, {}));
  clearSemanticModelProvider();
  const unwired = withMode('shadow', () => runSemanticSignals(STORED, INCOMING, {}));
  assert.equal(JSON.stringify(offResult), JSON.stringify(unwired));
  assert.equal('semanticModel' in offResult, false);
});

test('runSemanticSignals: shadow adds a separate typed field and changes nothing else', () => {
  const off = withMode('off', () => runSemanticSignals(STORED, INCOMING, {}));
  const shadow = withMode('shadow', () => runSemanticSignals(STORED, INCOMING, {}));
  assert.deepEqual(shadow.signals, off.signals);
  assert.deepEqual(shadow.summary, off.summary);
  assert.equal(shadow.semanticModel.mode, 'shadow');
  assert.equal(shadow.semanticModel.artifactDigest, SSM_DIGEST);
  assert.equal(shadow.semanticModel.band, 'ABSTAIN');
  assert.equal(shadow.signals.some(signal => signal.rule === 'semanticModel'), false);
});

test('buildVerifySemanticTrust: shadow keeps status, confidence and signals identical to off', () => {
  const off = withMode('off', () => buildVerifySemanticTrust(VERIFY_INPUT));
  const shadow = withMode('shadow', () => buildVerifySemanticTrust(VERIFY_INPUT));
  const { semanticModel, ...rest } = shadow;
  assert.equal(JSON.stringify(rest), JSON.stringify(off));
  assert.equal(semanticModel.artifactDigest, SSM_DIGEST);
  assert.equal(semanticModel.authority, 'CANDIDATE_ONLY');
});

test('buildVerifySemanticTrust: on mode with an uncalibrated model still decides nothing', () => {
  const off = withMode('off', () => buildVerifySemanticTrust(VERIFY_INPUT));
  const on = withMode('on', () => buildVerifySemanticTrust(VERIFY_INPUT));
  const { semanticModel, ...rest } = on;
  assert.equal(JSON.stringify(rest), JSON.stringify(off));
  assert.equal(semanticModel.mode, 'on');
  assert.equal(semanticModel.reviewPriority, 0);
});

test('buildVerifySemanticTrust: the model reads at most 16 edge pairs per verify', () => {
  const pairs = [];
  registerSemanticModelProvider(pair => {
    pairs.push(pair);
    return { family: 'SSM', artifactDigest: SSM_DIGEST, distribution: { CONTRADICTION: 0.25, ENTAILMENT: 0.25, NEUTRAL: 0.25, ABSTAIN: 0.25 } };
  });
  const edges = Array.from({ length: 40 }, (_, i) => ({ from: 'kahve', relation: 'IS', to: `şey${i}` }));
  const shadow = withMode('shadow', () => buildVerifySemanticTrust({ ...VERIFY_INPUT, edges }));
  assert.equal(pairs.length, 16);
  assert.equal(shadow.semanticModel.mode, 'shadow');
  pairs.length = 0;
  withMode('off', () => buildVerifySemanticTrust({ ...VERIFY_INPUT, edges }));
  assert.equal(pairs.length, 0);
});

test('buildVerifySemanticTrust: no edges means no pair and therefore no model field', () => {
  const shadow = withMode('shadow', () => buildVerifySemanticTrust({ ...VERIFY_INPUT, edges: [] }));
  assert.equal('semanticModel' in shadow, false);
});

test('a broken artifact never breaks verify: the rules still decide and the receipt names the reason', () => {
  registerSemanticModelProvider(createSemanticModelProvider({ env: {}, artifactDir: path.join(os.tmpdir(), 'missing-r51') }));
  const off = withMode('off', () => buildVerifySemanticTrust(VERIFY_INPUT));
  const shadow = withMode('shadow', () => buildVerifySemanticTrust(VERIFY_INPUT));
  const { semanticModel, ...rest } = shadow;
  assert.equal(JSON.stringify(rest), JSON.stringify(off));
  assert.equal(semanticModel.band, 'ABSTAIN');
  assert.equal(semanticModel.reason, 'artifact_unavailable:semantic_artifact_missing');
});

test('kernel verify end to end: the verdict is unchanged and the receipt preview carries the digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r51-verify-'));
  const log = console.log;
  const info = console.info;
  try {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
    kernel._autoMaintain = () => {};
    kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
    console.log = () => {};
    console.info = () => {};
    kernel.learn('coffee is stimulant', Kernel.createAdmissionBypassOpts('test_fixture_seed'));
    const off = withMode('off', () => kernel.verify('coffee is sedative'));
    const shadow = withMode('shadow', () => kernel.verify('coffee is sedative'));
    console.log = log;
    console.info = info;

    assert.equal(JSON.stringify(shadow.data), JSON.stringify(off.data));
    assert.deepEqual(shadow.evidence, off.evidence);
    assert.equal('semanticModel' in off.meta.semanticTrust, false);
    assert.equal('semanticModel' in off.meta.trustReceiptPreview, false);
    assert.equal(shadow.meta.semanticTrust.semanticModel.artifactDigest, SSM_DIGEST);
    assert.deepEqual(shadow.meta.trustReceiptPreview.semanticModel, {
      artifactDigest: SSM_DIGEST,
      family: 'SSM',
      mode: 'shadow',
      band: 'ABSTAIN',
      p: shadow.meta.semanticTrust.semanticModel.p,
      reviewPriority: 0,
      reason: 'uncalibrated',
    });
  } finally {
    console.log = log;
    console.info = info;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the runtime entrypoint registers the provider without any extra configuration', () => {
  clearSemanticModelProvider();
  assert.equal(withMode('shadow', () => runSemanticSignals(STORED, INCOMING, {})).semanticModel, undefined);
  require('../agentRuntime');
  const shadow = withMode('shadow', () => runSemanticSignals(STORED, INCOMING, {}));
  assert.equal(shadow.semanticModel.artifactDigest, SSM_DIGEST);
});
