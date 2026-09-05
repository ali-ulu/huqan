'use strict';

/**
 * F1a — declared-confidence capture.
 *
 * The caller's own confidence claim ("I am 94% sure") is recorded verbatim
 * for future calibration WITHOUT feeding any gate: admission risk reads
 * `confidence` (the policy/system value) only. These tests pin both halves:
 * the declaration is preserved, and recording it changes no decision.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Kernel = require('../kernel');
const { buildProvenance } = require('../lib/provenance-ingest');

// NOTE: no admission-bypass opts here on purpose — these tests need a real
// admission evaluation so there is a receipt to inspect.
const APPROVED = {
  admissionRequired: true,
  approvalRequired: true,
  approvalStatus: 'approved',
  approvalId: 'apr-f1a-declared-confidence',
};

function makeKernel(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-f1a-${name}-`));
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(dir, 'memory.json'),
    lang: 'tr',
    enableConcurrencyLock: false,
    loadPlugins: false,
  });
  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return { kernel, dir };
}

function mute(fn) {
  const orig = [console.log, console.info, console.warn, console.error];
  console.log = console.info = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    [console.log, console.info, console.warn, console.error] = orig;
  }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('buildProvenance keeps the raw declaration apart from the capped system value', () => {
  const { provenance } = buildProvenance({
    sourceType: 'bogus',
    sourceRef: 'docs/adr.md#claim',
    sourceTitle: 'Bad provenance',
    confidence: 1.4,
  });
  assert.strictEqual(provenance.confidence, 0.2);
  assert.strictEqual(provenance.declaredConfidence, 1);
  assert.strictEqual(provenance.declaredConfidenceSource, 'explicit');
});

test('buildProvenance marks absent declarations without touching the policy value', () => {
  const { provenance } = buildProvenance({
    sourceType: 'document',
    sourceRef: 'docs/adr.md#claim',
  }, { strictProvenance: false });
  assert.strictEqual(provenance.confidence, 0.8);
  assert.strictEqual(provenance.declaredConfidence, null);
  assert.strictEqual(provenance.declaredConfidenceSource, 'absent');
});

test('learn records the declaration on edge provenance and receipt metadata', () => {
  const { kernel, dir } = makeKernel('record');
  try {
    const res = mute(() => kernel.learn('Kedi hayvandir', {
      ...APPROVED,
      provenance: {
        sourceType: 'document',
        sourceRef: 'docs/adr.md#claim',
        sourceTitle: 'Trust Claim',
        actor: 'f1a-test',
        confidence: 0.94,
      },
    }));
    assert.strictEqual(res.data.learned, 1);
    const edge = kernel.graph.getEdge('kedi', 'hayvan', 'tür');
    assert.strictEqual(edge.provenance.declaredConfidence, 0.94);
    assert.strictEqual(edge.provenance.declaredConfidenceSource, 'explicit');
    assert.strictEqual(res.data.admission.receipt.metadata.declaredConfidence, 0.94);
  } finally {
    cleanup(dir);
  }
});

test('learn without a declaration leaves receipt metadata byte-identical to before', () => {
  const { kernel, dir } = makeKernel('absent');
  try {
    const res = mute(() => kernel.learn('Kedi hayvandir', {
      ...APPROVED,
      provenance: {
        sourceType: 'document',
        sourceRef: 'docs/adr.md#claim',
        sourceTitle: 'Trust Claim',
        actor: 'f1a-test',
      },
    }));
    assert.strictEqual(res.data.learned, 1);
    assert.strictEqual(Object.hasOwn(res.data.admission.receipt.metadata, 'declaredConfidence'), false);
    const edge = kernel.graph.getEdge('kedi', 'hayvan', 'tür');
    assert.strictEqual(edge.provenance.declaredConfidence, null);
  } finally {
    cleanup(dir);
  }
});

test('top-level opts confidence is captured as a declaration too', () => {
  const { provenance } = buildProvenance(
    { sourceType: 'document', sourceRef: 'docs/adr.md#claim' },
    { strictProvenance: false, confidence: 0.61 },
  );
  assert.strictEqual(provenance.declaredConfidence, 0.61);
  assert.strictEqual(provenance.declaredConfidenceSource, 'explicit');
});
