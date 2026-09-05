'use strict';

/**
 * F2 — robustness-lite probe tests.
 *
 * Unit tests pin the stressor builders; integration tests run the probe
 * against a real kernel.verify (temp graph, no repo writes). A stubbed
 * verify pins the scoring: the flip is scored, never the confidence
 * number (F0-B finding).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Kernel = require('../../kernel');
const {
  ROBUSTNESS_VERSION,
  negateStatement,
  swapNumericValue,
  swapEntity,
  runRobustnessProbe,
} = require('./robustness');

function makeKernel(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-f2-${name}-`));
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

function unwrap(result) {
  return result && typeof result === 'object' && result.data && typeof result.data === 'object'
    ? result.data
    : result;
}

test('negateStatement handles TR copula, explicit negation, and EN is', () => {
  assert.strictEqual(negateStatement('Kedi hayvandir'), 'Kedi hayvan değildir');
  assert.strictEqual(negateStatement('kedi hayvan değildir'), 'kedi hayvan');
  assert.strictEqual(negateStatement('Smoking is health'), 'Smoking is not health');
  assert.strictEqual(negateStatement('Su 100 derecede kaynar'), null);
  assert.strictEqual(negateStatement(''), null);
  assert.strictEqual(negateStatement(null), null);
});

test('swapNumericValue halves the first integer, null without a number', () => {
  assert.strictEqual(swapNumericValue('Su 100 derecede kaynar'), 'Su 50 derecede kaynar');
  assert.strictEqual(swapNumericValue('Kedi hayvandir'), null);
});

test('swapEntity swaps an opposition pair term for its mate', () => {
  assert.strictEqual(swapEntity('güvenli liman'), 'riskli liman');
  assert.strictEqual(swapEntity('Kedi hayvandir'), null);
  // Whole-word only: a copula-suffixed form must not false-positive.
  assert.strictEqual(swapEntity('Sigara güvenlidir'), null);
});

test('probe scores a fully sensitive claim at 1', () => {
  const { kernel, dir } = makeKernel('sensitive');
  try {
    const bypass = Kernel.createAdmissionBypassOpts('f2_probe');
    mute(() => {
      kernel.learn('Su 100 derecede kaynar', { ...bypass });
      kernel.learn('Kedi hayvandir', { ...bypass });
    });
    const verify = (stmt, verifyOpts) => unwrap(kernel.verify(stmt, { workspaceId: 'default', ...verifyOpts }));
    const first = runRobustnessProbe(verify, 'Su 100 derecede kaynar');
    assert.strictEqual(first.version, ROBUSTNESS_VERSION);
    assert.strictEqual(first.applicable, true);
    assert.strictEqual(first.score, 1);
    assert.deepStrictEqual(first.flags, []);
    assert.ok(first.axes.some((a) => a.axis === 'valueSwap' && a.pass === true));
    const second = runRobustnessProbe(verify, 'Su 100 derecede kaynar');
    assert.deepStrictEqual(second, first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probe passes the negation axis when the flip lands contradicted', () => {
  const { kernel, dir } = makeKernel('negation');
  try {
    const bypass = Kernel.createAdmissionBypassOpts('f2_probe');
    mute(() => { kernel.learn('Kedi hayvandir', { ...bypass }); });
    const verify = (stmt, verifyOpts) => unwrap(kernel.verify(stmt, { workspaceId: 'default', ...verifyOpts }));
    const report = runRobustnessProbe(verify, 'Kedi hayvandir');
    assert.strictEqual(report.applicable, true);
    const axis = report.axes.find((a) => a.axis === 'negation');
    assert.ok(axis, 'negation axis should apply to a copula claim');
    assert.strictEqual(axis.stressedStatus, 'contradicted');
    assert.strictEqual(axis.pass, true);
    assert.strictEqual(report.score, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probe penalizes an unfalsifiable claim even at high confidence (stub)', () => {
  const alwaysVerified = () => ({ status: 'verified', confidence: 0.99 });
  const report = runRobustnessProbe(alwaysVerified, 'Kedi hayvandir');
  assert.strictEqual(report.applicable, true);
  assert.ok(report.score < 1, `expected penalty, got ${report.score}`);
  assert.ok(report.flags.includes('FRAGILE_UNFALSIFIABLE'));
});

test('probe is inapplicable when the baseline does not verify', () => {
  const { kernel, dir } = makeKernel('baseline');
  try {
    const verify = (stmt, verifyOpts) => unwrap(kernel.verify(stmt, { workspaceId: 'default', ...verifyOpts }));
    const report = runRobustnessProbe(verify, 'Mars peynirdendir');
    assert.strictEqual(report.applicable, false);
    assert.strictEqual(report.score, null);
    assert.ok(report.flags.includes('BASELINE_NOT_VERIFIED'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probe requires a verify function', () => {
  assert.throws(() => runRobustnessProbe(null, 'Kedi hayvandir'), { name: 'TypeError' });
});
