const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-verify-semantic-'));

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

function seedFacts(kernel) {
  const seeds = [
    'B737 is aircraft',
    'B737 has 2 engines',
    'A380 is widebody aircraft',
    'A380 has 4 engines',
    'C172 is piston aircraft',
    'EDDF is in Frankfurt',
    'TCAS detects traffic',
    'Mayday is distress call',
    'Pan-Pan is urgency call',
    'aspirin ağrı kesici olarak kullanılır',
    'aspirin kan inceltici olarak etki eder',
  ];

  withMutedConsole(() => {
    for (const seed of seeds) {
      kernel.learn(seed, { workspaceId: 'default' });
    }
  });
}

describe('verify semantic integration', () => {
  it('preserves exact support as dogrulandi and attaches semantic trust meta', () => {
    const kernel = makeKernel('exact-support');
    seedFacts(kernel);

    const raw = kernel.verify('B737 has 2 engines', { workspaceId: 'default' });
    const result = unwrap(raw);
    const semanticTrust = raw.meta.semanticTrust;

    assert.ok(result && typeof result === 'object', 'verify result should be an object');
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must remain stable');
    assert.strictEqual(result.status, 'dogrulandi');
    assert.ok(semanticTrust && typeof semanticTrust === 'object', 'semantic trust meta should be attached');
    assert.ok(Array.isArray(semanticTrust.signals), 'semantic trust signals should be an array');
    assert.ok(semanticTrust.thresholds, 'semantic trust thresholds should be attached');
    assert.ok(semanticTrust.supportScore >= semanticTrust.thresholds.supportVerified, 'support score should be high for exact support');
    assert.strictEqual(semanticTrust.status, 'dogrulandi');
    assert.strictEqual(semanticTrust.classification, 'verified');
  });

  it('downgrades weak partial matches to bilinmiyor', () => {
    const kernel = makeKernel('weak-partial');
    seedFacts(kernel);

    const raw = kernel.verify('B737 aircraft', { workspaceId: 'default' });
    const result = unwrap(raw);
    const semanticTrust = raw.meta.semanticTrust;

    assert.ok(result && typeof result === 'object', 'verify result should be an object');
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status), 'status contract must remain stable');
    assert.notStrictEqual(result.status, 'dogrulandi');
    assert.ok(semanticTrust && typeof semanticTrust === 'object', 'semantic trust meta should be attached');
    assert.ok(semanticTrust.supportScore < semanticTrust.thresholds.supportVerified, 'weak partial support must stay below verification threshold');
    assert.ok(['weak_match', 'unsupported', 'needs_review', 'contradicted'].includes(semanticTrust.classification), 'weak partial should not be verified');
    assert.notStrictEqual(semanticTrust.status, 'dogrulandi');
  });

  it('keeps unsupported claims as bilinmiyor', () => {
    const kernel = makeKernel('unsupported');
    seedFacts(kernel);

    const raw = kernel.verify('mavi fikirler sessizce koşar', { workspaceId: 'default' });
    const result = unwrap(raw);
    const semanticTrust = raw.meta.semanticTrust;

    assert.ok(result && typeof result === 'object', 'verify result should be an object');
    assert.strictEqual(result.status, 'bilinmiyor');
    assert.ok(semanticTrust && typeof semanticTrust === 'object', 'semantic trust meta should be attached');
    assert.strictEqual(semanticTrust.status, 'bilinmiyor');
    assert.strictEqual(semanticTrust.classification, 'unsupported');
    assert.ok(Array.isArray(semanticTrust.signals), 'semantic trust signals should be an array');
    assert.ok(!['needs_review', 'weak_match', 'unsupported', 'llm-assisted'].includes(result.status), 'core status contract must remain unchanged');
  });

  it('promotes strong contradictions to celiski', () => {
    const kernel = makeKernel('contradiction');
    seedFacts(kernel);

    const raw = kernel.verify('B737 has 4 engines', { workspaceId: 'default' });
    const result = unwrap(raw);
    const semanticTrust = raw.meta.semanticTrust;

    assert.ok(result && typeof result === 'object', 'verify result should be an object');
    assert.strictEqual(result.status, 'celiski');
    assert.ok(semanticTrust && typeof semanticTrust === 'object', 'semantic trust meta should be attached');
    assert.strictEqual(semanticTrust.status, 'celiski');
    assert.strictEqual(semanticTrust.classification, 'contradicted');
    assert.ok(
      semanticTrust.signals.some(signal => Array.isArray(signal.flags) && (
        signal.flags.includes('SEMANTIC_OPPOSITION') ||
        signal.flags.includes('VALUE_CONFLICT') ||
        signal.flags.includes('TYPE_CONFLICT') ||
        signal.flags.includes('NUMERICAL_CONFLICT') ||
        signal.flags.includes('NEGATION_CONFLICT')
      )),
      'strong contradiction should emit a contradiction signal',
    );
  });

  it('promotes graph-aware type lattice conflicts to celiski', () => {
    const kernel = makeKernel('type-lattice');
    kernel.graph.addNode('köpek', 'köpek', null, { workspaceId: 'default' });
    kernel.graph.addNode('hayvan', 'hayvan', null, { workspaceId: 'default' });
    kernel.graph.addNode('canlı', 'canlı', null, { workspaceId: 'default' });
    kernel.graph.addNode('organizma', 'organizma', null, { workspaceId: 'default' });
    kernel.graph.addEdge('köpek', 'hayvan', 'tür', { workspaceId: 'default' });
    kernel.graph.addEdge('hayvan', 'canlı', 'tür', { workspaceId: 'default' });
    kernel.graph.addEdge('canlı', 'organizma', 'tür', { workspaceId: 'default' });

    const raw = kernel.verify('köpek bitkidir', { workspaceId: 'default' });
    const result = unwrap(raw);
    const semanticTrust = raw.meta.semanticTrust;

    assert.ok(result && typeof result === 'object', 'verify result should be an object');
    assert.strictEqual(result.status, 'celiski');
    assert.ok(semanticTrust && typeof semanticTrust === 'object', 'semantic trust meta should be attached');
    assert.strictEqual(semanticTrust.status, 'celiski');
    assert.ok(
      semanticTrust.warnings.includes('TYPE_CONFLICT') ||
      semanticTrust.warnings.includes('TYPE_LATTICE_CONFLICT'),
      'type lattice conflict should surface in warnings',
    );
  });

  it('keeps high-risk weak claims as bilinmiyor with risk flags', () => {
    const kernel = makeKernel('high-risk');
    seedFacts(kernel);

    const raw = kernel.verify('aspirin her zaman güvenlidir', { workspaceId: 'default' });
    const result = unwrap(raw);
    const semanticTrust = raw.meta.semanticTrust;

    assert.ok(result && typeof result === 'object', 'verify result should be an object');
    assert.strictEqual(result.status, 'bilinmiyor');
    assert.ok(semanticTrust && typeof semanticTrust === 'object', 'semantic trust meta should be attached');
    assert.strictEqual(semanticTrust.status, 'bilinmiyor');
    assert.ok(['needs_review', 'weak_match', 'unsupported'].includes(semanticTrust.classification), 'high-risk weak claim should not be verified');
    assert.ok(Array.isArray(semanticTrust.warnings), 'warnings should be an array');
    assert.ok(
      semanticTrust.risk.flags.includes('HIGH_RISK_DOMAIN') ||
      semanticTrust.risk.flags.includes('ABSOLUTE_CLAIM'),
      'high-risk weak claim should carry risk flags',
    );
  });
});
