'use strict';

/**
 * F3 — observation-only robustness wiring on verify().
 *
 * `kernel.verify(stmt, { robustness: true })` attaches a `robustness`
 * report to the envelope meta. These tests pin the additive contract:
 * default and explicit-false calls return envelopes without the key,
 * and the opt-in never changes status/confidence/evidence.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Kernel = require('../kernel');

function makeKernel(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-f3-${name}-`));
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

function seed(kernel) {
  const bypass = Kernel.createAdmissionBypassOpts('f3_probe');
  mute(() => {
    kernel.learn('Su 100 derecede kaynar', { ...bypass });
    kernel.learn('Kedi hayvandir', { ...bypass });
  });
}

test('opt-in verify attaches a robustness report without changing the verdict', () => {
  const { kernel, dir } = makeKernel('optin');
  try {
    seed(kernel);
    const plain = mute(() => kernel.verify('Su 100 derecede kaynar', { workspaceId: 'default' }));
    const probed = mute(() => kernel.verify('Su 100 derecede kaynar', { workspaceId: 'default', robustness: true }));
    assert.strictEqual(Object.hasOwn(plain.meta || {}, 'robustness'), false);
    assert.ok(probed.meta && typeof probed.meta.robustness === 'object');
    assert.strictEqual(probed.meta.robustness.version, 'robustness-lite-v1');
    assert.strictEqual(probed.meta.robustness.applicable, true);
    assert.strictEqual(probed.meta.robustness.score, 1);
    assert.deepStrictEqual(unwrap(probed).status, unwrap(plain).status);
    assert.deepStrictEqual(unwrap(probed).confidence, unwrap(plain).confidence);
    assert.deepStrictEqual(unwrap(probed).evidence, unwrap(plain).evidence);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit-false verify stays byte-identical to default', () => {
  const { kernel, dir } = makeKernel('off');
  try {
    seed(kernel);
    const def = mute(() => kernel.verify('Kedi hayvandir', { workspaceId: 'default' }));
    const off = mute(() => kernel.verify('Kedi hayvandir', { workspaceId: 'default', robustness: false }));
    assert.strictEqual(Object.hasOwn(off.meta || {}, 'robustness'), false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(off)), JSON.parse(JSON.stringify(def)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probed verify of an unverified claim reports inapplicable, still unchanged', () => {
  const { kernel, dir } = makeKernel('unknown');
  try {
    seed(kernel);
    const probed = mute(() => kernel.verify('Mars peynirdendir', { workspaceId: 'default', robustness: true }));
    assert.strictEqual(unwrap(probed).status, 'unknown');
    assert.strictEqual(probed.meta.robustness.applicable, false);
    assert.strictEqual(probed.meta.robustness.score, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
