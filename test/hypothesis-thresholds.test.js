'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const CLI = require('../cli');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const { DEFAULTS } = require('../lib/graph-hypotheses');
const { buildHypothesisCandidate } = require('../lib/graph-hypotheses');
const { reviewHypothesisCandidate } = require('../lib/hypothesis-review');
const { buildFeedbackStats } = require('../lib/hypothesis-feedback');
const { buildTuningAdvice } = require('../lib/hypothesis-tuning');
const {
  applyThresholds,
  readStoredThresholds,
  resolveThresholds,
  thresholdStorePath,
} = require('../lib/hypothesis-thresholds');

function createCli(label) {
  const kernel = new Kernel(isolatedKernelOptions(label));
  const cli = new CLI({ kernelInstance: kernel });
  return { kernel, cli };
}

function closeCli({ kernel, cli }) {
  cli?.agent?.storage?.close?.();
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

let seq = 0;
/** Seeds one rule past the sample floor with a rejection rate above the trigger. */
function seedNoisyRule(kernel, type, workspaceId = 'default', { accepted = 1, rejected = 9 } = {}) {
  const decisions = [
    ...Array(accepted).fill('accept'),
    ...Array(rejected).fill('reject'),
  ];
  for (const decision of decisions) {
    seq += 1;
    const candidate = buildHypothesisCandidate({
      type, severity: 'high', target: `t${seq}`, confidence: 0.9, gerekce: `${type} ${seq}.`,
    }, workspaceId);
    kernel.addCandidateClaim(candidate, { workspaceId });
    reviewHypothesisCandidate(kernel, { candidateId: candidate.candidateId, decision, workspaceId });
  }
}

function adviceFor(kernel, workspaceId = 'default') {
  return buildTuningAdvice(buildFeedbackStats(kernel, { workspaceId }), readStoredThresholds(kernel, workspaceId));
}

test('an unwritten store reads as empty, and resolve falls through to the engine defaults', () => {
  const managed = createCli('thresholds-empty');
  try {
    assert.deepEqual(readStoredThresholds(managed.kernel), {});
    assert.deepEqual(resolveThresholds({}, {}), {
      confidenceFloor: DEFAULTS.confidenceFloor,
      criticalInDegree: DEFAULTS.criticalInDegree,
      smallComponentSize: DEFAULTS.smallComponentSize,
    });
    assert.equal(fs.existsSync(thresholdStorePath(managed.kernel)), false, 'reading must not create the file');
  } finally {
    closeCli(managed);
  }
});

test('an explicit flag beats a stored value, and a stored value beats the default', () => {
  const stored = { confidenceFloor: 0.25, criticalInDegree: 8 };
  const resolved = resolveThresholds(stored, { criticalInDegree: 3 });
  assert.equal(resolved.criticalInDegree, 3, 'the flag says "for this run, use this"');
  assert.equal(resolved.confidenceFloor, 0.25, 'no flag, so the stored value stands');
  assert.equal(resolved.smallComponentSize, DEFAULTS.smallComponentSize, 'neither, so the default');
});

test('applying a suggestion persists it and the next read returns it', () => {
  const managed = createCli('thresholds-apply');
  try {
    const kernel = managed.kernel;
    seedNoisyRule(kernel, 'KRİTİK_DÜĞÜM');
    const advice = adviceFor(kernel);
    assert.equal(advice.suggestions.length, 1);

    const result = applyThresholds(kernel, 'default', advice.suggestions);
    assert.deepEqual(result.applied, [
      { option: 'criticalInDegree', ruleType: 'KRİTİK_DÜĞÜM', before: DEFAULTS.criticalInDegree, after: DEFAULTS.criticalInDegree + 1 },
    ]);
    assert.deepEqual(readStoredThresholds(kernel), { criticalInDegree: DEFAULTS.criticalInDegree + 1 });
  } finally {
    closeCli(managed);
  }
});

test('applying an empty suggestion list writes nothing and says so', () => {
  const managed = createCli('thresholds-apply-empty');
  try {
    const result = applyThresholds(managed.kernel, 'default', []);
    assert.deepEqual(result.applied, []);
    assert.equal(result.written, false);
    assert.equal(fs.existsSync(thresholdStorePath(managed.kernel)), false);
  } finally {
    closeCli(managed);
  }
});

test('a second apply builds on the stored value rather than the default', () => {
  const managed = createCli('thresholds-compounding');
  try {
    const kernel = managed.kernel;
    seedNoisyRule(kernel, 'KRİTİK_DÜĞÜM');
    applyThresholds(kernel, 'default', adviceFor(kernel).suggestions);
    assert.equal(readStoredThresholds(kernel).criticalInDegree, DEFAULTS.criticalInDegree + 1);

    // The rule is still noisy, so the next round moves from 6, not from 5.
    applyThresholds(kernel, 'default', adviceFor(kernel).suggestions);
    assert.equal(readStoredThresholds(kernel).criticalInDegree, DEFAULTS.criticalInDegree + 2);
  } finally {
    closeCli(managed);
  }
});

test('stored thresholds are per workspace', () => {
  const managed = createCli('thresholds-workspace');
  try {
    const kernel = managed.kernel;
    seedNoisyRule(kernel, 'KRİTİK_DÜĞÜM', 'alpha');
    applyThresholds(kernel, 'alpha', adviceFor(kernel, 'alpha').suggestions);
    assert.equal(readStoredThresholds(kernel, 'alpha').criticalInDegree, DEFAULTS.criticalInDegree + 1);
    assert.deepEqual(readStoredThresholds(kernel, 'beta'), {});
  } finally {
    closeCli(managed);
  }
});

test('an apply leaves an audit event carrying why the threshold moved', () => {
  const managed = createCli('thresholds-audit');
  try {
    const kernel = managed.kernel;
    seedNoisyRule(kernel, 'KRİTİK_DÜĞÜM');
    applyThresholds(kernel, 'default', adviceFor(kernel).suggestions);

    const event = kernel.graph.getAuditEvents({ workspaceId: 'default' })
      .find(item => item.targetType === 'hypothesis_thresholds');
    assert.ok(event, 'a threshold change must be traceable back to its evidence');
    assert.equal(event.eventType, 'UPDATE');
    assert.deepEqual(event.details.applied[0], {
      option: 'criticalInDegree',
      ruleType: 'KRİTİK_DÜĞÜM',
      before: DEFAULTS.criticalInDegree,
      after: DEFAULTS.criticalInDegree + 1,
    });
    assert.equal(event.details.evidence[0].reviewed, 10);
    assert.equal(event.details.evidence[0].rejectionRate, 0.9);
  } finally {
    closeCli(managed);
  }
});

test('a malformed store is refused fail-closed rather than silently reset', () => {
  const managed = createCli('thresholds-malformed');
  try {
    fs.writeFileSync(thresholdStorePath(managed.kernel), '{ bozuk json');
    assert.throws(
      () => readStoredThresholds(managed.kernel),
      error => error.code === 'HYPOTHESIS_THRESHOLDS_UNREADABLE',
    );
  } finally {
    closeCli(managed);
  }
});

test('a stored value outside what generateHypotheses accepts is refused, not clamped', () => {
  const managed = createCli('thresholds-out-of-range');
  try {
    fs.writeFileSync(
      thresholdStorePath(managed.kernel),
      JSON.stringify({ version: 1, workspaces: { default: { confidenceFloor: 5 } } }),
    );
    assert.throws(
      () => readStoredThresholds(managed.kernel),
      error => error.code === 'HYPOTHESIS_THRESHOLDS_OUT_OF_RANGE',
    );
  } finally {
    closeCli(managed);
  }
});

test('hypotheses tuning without --apply still writes nothing', async () => {
  const managed = createCli('thresholds-cli-advice-only');
  try {
    seedNoisyRule(managed.kernel, 'KRİTİK_DÜĞÜM');
    const stdout = [];
    await runCliArgv(['hypotheses', 'tuning', '--json'], { cli: managed.cli, stdout: v => stdout.push(v) });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(envelope.data.tuning.applied, false);
    assert.equal(fs.existsSync(thresholdStorePath(managed.kernel)), false);
  } finally {
    closeCli(managed);
  }
});

test('hypotheses tuning --apply persists and reports what it changed', async () => {
  const managed = createCli('thresholds-cli-apply');
  try {
    seedNoisyRule(managed.kernel, 'KRİTİK_DÜĞÜM');
    const stdout = [];
    const result = await runCliArgv(['hypotheses', 'tuning', '--apply', '--json'], {
      cli: managed.cli,
      stdout: v => stdout.push(v),
    });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.data.tuning.applied, true);
    assert.equal(envelope.data.tuning.application.applied[0].option, 'criticalInDegree');
    assert.equal(readStoredThresholds(managed.kernel).criticalInDegree, DEFAULTS.criticalInDegree + 1);
  } finally {
    closeCli(managed);
  }
});

test('the hypotheses report honours a stored threshold', async () => {
  const managed = createCli('thresholds-cli-report');
  try {
    const kernel = managed.kernel;
    for (const id of ['a', 'b', 'c']) kernel.graph.addNode(id, id, null, { workspaceId: 'default' });
    kernel.graph.addEdge('a', 'b', 'supports', { workspaceId: 'default', confidence: 0.9, evidence: ['a'] });
    kernel.graph.addEdge('c', 'b', 'supports', { workspaceId: 'default', confidence: 0.9, evidence: ['c'] });

    fs.writeFileSync(
      thresholdStorePath(kernel),
      JSON.stringify({ version: 1, workspaces: { default: { criticalInDegree: 2 } } }),
    );

    const stdout = [];
    await runCliArgv(['hypotheses', '--json'], { cli: managed.cli, stdout: v => stdout.push(v) });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(envelope.data.meta.criticalInDegree, 2, 'the stored value reached the engine');
    assert.equal(envelope.data.hypotheses.some(h => h.type === 'KRİTİK_DÜĞÜM' && h.target === 'b'), true);
  } finally {
    closeCli(managed);
  }
});

test('an explicit flag overrides the stored threshold for that run only', async () => {
  const managed = createCli('thresholds-cli-flag');
  try {
    const kernel = managed.kernel;
    fs.writeFileSync(
      thresholdStorePath(kernel),
      JSON.stringify({ version: 1, workspaces: { default: { criticalInDegree: 2 } } }),
    );
    const stdout = [];
    await runCliArgv(['hypotheses', '--critical', '9', '--json'], { cli: managed.cli, stdout: v => stdout.push(v) });
    assert.equal(JSON.parse(stdout[0]).data.meta.criticalInDegree, 9);
    assert.equal(readStoredThresholds(kernel).criticalInDegree, 2, 'a flag is not a write');
  } finally {
    closeCli(managed);
  }
});
