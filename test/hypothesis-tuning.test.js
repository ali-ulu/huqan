'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CLI = require('../cli');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const { DEFAULTS } = require('../lib/graph-hypotheses');
const { buildFeedbackStats } = require('../lib/hypothesis-feedback');
const {
  MIN_REVIEWED,
  REJECTION_TRIGGER,
  TUNABLE_OPTIONS,
  buildTuningAdvice,
} = require('../lib/hypothesis-tuning');

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

/** A feedback-stats shape with one rule, built directly so the mapping is tested in isolation. */
function statsFor(rows) {
  const rules = rows.map(({ ruleType, accepted, rejected, pending = 0 }) => {
    const reviewed = accepted + rejected;
    return {
      ruleType,
      accepted,
      rejected,
      pending,
      reviewed,
      total: reviewed + pending,
      acceptanceRate: reviewed > 0 ? accepted / reviewed : null,
      rejectionRate: reviewed > 0 ? rejected / reviewed : null,
    };
  });
  return { meta: { workspaceId: 'default', candidateCount: 0, ruleCount: rules.length }, rules, totals: {} };
}

function suggestionFor(advice, ruleType) {
  return advice.suggestions.find(item => item.ruleType === ruleType);
}

function skipFor(advice, ruleType) {
  return advice.skipped.find(item => item.ruleType === ruleType);
}

test('a noisy ZAYIF_BAĞ lowers the confidence floor so fewer edges are flagged', () => {
  const advice = buildTuningAdvice(statsFor([{ ruleType: 'ZAYIF_BAĞ', accepted: 1, rejected: 9 }]));
  const suggestion = suggestionFor(advice, 'ZAYIF_BAĞ');
  assert.equal(suggestion.option, 'confidenceFloor');
  assert.equal(suggestion.currentValue, DEFAULTS.confidenceFloor);
  assert.ok(suggestion.suggestedValue < suggestion.currentValue);
  assert.equal(suggestion.reviewed, 10);
  assert.equal(suggestion.rejectionRate, 0.9);
  assert.match(suggestion.reason, /ZAYIF_BAĞ/);
});

test('a noisy KRİTİK_DÜĞÜM raises the in-degree threshold', () => {
  const advice = buildTuningAdvice(statsFor([{ ruleType: 'KRİTİK_DÜĞÜM', accepted: 2, rejected: 8 }]));
  const suggestion = suggestionFor(advice, 'KRİTİK_DÜĞÜM');
  assert.equal(suggestion.option, 'criticalInDegree');
  assert.equal(suggestion.suggestedValue, DEFAULTS.criticalInDegree + 1);
  assert.equal(Number.isInteger(suggestion.suggestedValue), true);
});

test('a noisy KÜÇÜK_BİLEŞEN lowers the small-component size', () => {
  const advice = buildTuningAdvice(statsFor([{ ruleType: 'KÜÇÜK_BİLEŞEN', accepted: 0, rejected: 6 }]));
  const suggestion = suggestionFor(advice, 'KÜÇÜK_BİLEŞEN');
  assert.equal(suggestion.option, 'smallComponentSize');
  assert.equal(suggestion.suggestedValue, DEFAULTS.smallComponentSize - 1);
});

test('a rule below the sample floor gets no suggestion', () => {
  const rejected = MIN_REVIEWED - 1;
  const advice = buildTuningAdvice(statsFor([{ ruleType: 'ZAYIF_BAĞ', accepted: 0, rejected }]));
  assert.equal(suggestionFor(advice, 'ZAYIF_BAĞ'), undefined);
  const skipped = skipFor(advice, 'ZAYIF_BAĞ');
  assert.equal(skipped.reason, 'insufficient_data');
  assert.equal(skipped.reviewed, rejected);
});

test('a rule reviewed enough but not noisy enough gets no suggestion', () => {
  // Exactly at the trigger is not above it: the boundary does not fire.
  const advice = buildTuningAdvice(statsFor([{ ruleType: 'ZAYIF_BAĞ', accepted: 4, rejected: 6 }]));
  assert.equal(REJECTION_TRIGGER, 0.6);
  assert.equal(suggestionFor(advice, 'ZAYIF_BAĞ'), undefined);
  assert.equal(skipFor(advice, 'ZAYIF_BAĞ').reason, 'within_tolerance');
});

test('a rule with no tunable threshold is reported as such, not silently dropped', () => {
  const advice = buildTuningAdvice(statsFor([{ ruleType: 'NEDENSEL_DÖNGÜ', accepted: 0, rejected: 10 }]));
  assert.equal(suggestionFor(advice, 'NEDENSEL_DÖNGÜ'), undefined);
  assert.equal(skipFor(advice, 'NEDENSEL_DÖNGÜ').reason, 'no_tunable_threshold');
});

test('only the three real generateHypotheses options are ever suggested', () => {
  const advice = buildTuningAdvice(statsFor([
    { ruleType: 'ZAYIF_BAĞ', accepted: 0, rejected: 10 },
    { ruleType: 'KRİTİK_DÜĞÜM', accepted: 0, rejected: 10 },
    { ruleType: 'KÜÇÜK_BİLEŞEN', accepted: 0, rejected: 10 },
    { ruleType: 'KANIT_EKSİK', accepted: 0, rejected: 10 },
    { ruleType: 'YALITILMIŞ_DÜĞÜM', accepted: 0, rejected: 10 },
  ]));
  assert.deepEqual(
    [...new Set(advice.suggestions.map(item => item.option))].sort(),
    ['confidenceFloor', 'criticalInDegree', 'smallComponentSize'],
  );
  assert.deepEqual(Object.keys(TUNABLE_OPTIONS).sort(), ['KRİTİK_DÜĞÜM', 'KÜÇÜK_BİLEŞEN', 'ZAYIF_BAĞ']);
});

test('suggestions respect the bounds generateHypotheses enforces', () => {
  const noisy = { accepted: 0, rejected: 10 };
  const atFloor = buildTuningAdvice(statsFor([{ ruleType: 'ZAYIF_BAĞ', ...noisy }]), { confidenceFloor: 0.02 });
  assert.equal(suggestionFor(atFloor, 'ZAYIF_BAĞ').suggestedValue, 0);

  const atMin = buildTuningAdvice(statsFor([{ ruleType: 'KÜÇÜK_BİLEŞEN', ...noisy }]), { smallComponentSize: 2 });
  // Already at the minimum generateHypotheses accepts: there is nothing to
  // suggest, and proposing an out-of-range value would be worse than silence.
  assert.equal(suggestionFor(atMin, 'KÜÇÜK_BİLEŞEN'), undefined);
  assert.equal(skipFor(atMin, 'KÜÇÜK_BİLEŞEN').reason, 'already_at_bound');
});

test('current values come from the caller when given, and from DEFAULTS otherwise', () => {
  const advice = buildTuningAdvice(
    statsFor([{ ruleType: 'KRİTİK_DÜĞÜM', accepted: 0, rejected: 10 }]),
    { criticalInDegree: 9 },
  );
  const suggestion = suggestionFor(advice, 'KRİTİK_DÜĞÜM');
  assert.equal(suggestion.currentValue, 9);
  assert.equal(suggestion.suggestedValue, 10);
});

test('advice is deterministic and sorted by rule type', () => {
  const stats = statsFor([
    { ruleType: 'ZAYIF_BAĞ', accepted: 0, rejected: 10 },
    { ruleType: 'KRİTİK_DÜĞÜM', accepted: 0, rejected: 10 },
    { ruleType: 'KÜÇÜK_BİLEŞEN', accepted: 0, rejected: 10 },
  ]);
  const first = buildTuningAdvice(stats);
  assert.deepEqual(first, buildTuningAdvice(stats));
  assert.deepEqual(
    first.suggestions.map(item => item.ruleType),
    [...first.suggestions.map(item => item.ruleType)].sort((l, r) => l.localeCompare(r)),
  );
});

test('empty feedback produces empty advice, not an error', () => {
  const advice = buildTuningAdvice({ meta: { workspaceId: 'default' }, rules: [], totals: {} });
  assert.deepEqual(advice.suggestions, []);
  assert.deepEqual(advice.skipped, []);
});

test('advice applies nothing: it reads stats and returns a proposal only', async () => {
  const managed = createCli('tuning-read-only');
  try {
    const kernel = managed.kernel;
    const calls = [];
    for (const method of ['addNode', 'addEdge', 'addCandidateClaim', 'appendAuditEvent']) {
      const original = kernel.graph[method].bind(kernel.graph);
      kernel.graph[method] = (...args) => { calls.push(method); return original(...args); };
    }
    buildTuningAdvice(buildFeedbackStats(kernel));
    assert.deepEqual(calls, []);
    // The engine's own defaults are untouched: advice is not application.
    assert.equal(DEFAULTS.confidenceFloor, 0.4);
    assert.equal(DEFAULTS.criticalInDegree, 5);
    assert.equal(DEFAULTS.smallComponentSize, 3);
  } finally {
    closeCli(managed);
  }
});

test('hypotheses tuning is reachable from the CLI and emits a JSON workflow envelope', async () => {
  const managed = createCli('tuning-cli');
  try {
    const stdout = [];
    const result = await runCliArgv(['hypotheses', 'tuning', '--json'], {
      cli: managed.cli,
      stdout: value => stdout.push(value),
    });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.workflowId, 'hypotheses');
    assert.equal(envelope.status, 'completed');
    assert.deepEqual(envelope.data.tuning.suggestions, []);
    assert.equal(envelope.data.tuning.applied, false);
  } finally {
    closeCli(managed);
  }
});
