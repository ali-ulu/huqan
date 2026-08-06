const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policyWatchdog = require('./policy-watchdog');
const { ensureWatchdogState, checkPolicy, hashPolicy } = policyWatchdog._test;

function fakeKernel() {
  return {};
}

function writePolicy(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(content));
  return filePath;
}

test('policy-watchdog: hashPolicy is stable for identical content and differs for different content', () => {
  const a = hashPolicy({ version: '1.0' });
  const b = hashPolicy({ version: '1.0' });
  const c = hashPolicy({ version: '1.1' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('policy-watchdog: checkPolicy establishes a baseline on the first call, does not lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-watchdog-'));
  try {
    const policyPath = writePolicy(dir, 'policy.json', { version: '1.0', rules: [] });
    const kernel = fakeKernel();
    const state = checkPolicy(kernel, { policyPath });
    assert.equal(state.locked, false);
    assert.equal(state.baselineVersion, '1.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('policy-watchdog: checkPolicy locks when the policy content changes after the baseline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-watchdog-'));
  try {
    const policyPath = path.join(dir, 'policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({ version: '1.0', rules: ['a'] }));
    const kernel = fakeKernel();

    checkPolicy(kernel, { policyPath }); // establishes baseline
    fs.writeFileSync(policyPath, JSON.stringify({ version: '1.1', rules: ['a', 'b'] })); // changed mid-run
    const state = checkPolicy(kernel, { policyPath });

    assert.equal(state.locked, true);
    assert.match(state.lockedReason, /1\.0.*1\.1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('policy-watchdog: checkPolicy does not lock when re-reading identical content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-watchdog-'));
  try {
    const policyPath = writePolicy(dir, 'policy.json', { version: '1.0', rules: [] });
    const kernel = fakeKernel();
    checkPolicy(kernel, { policyPath });
    const state = checkPolicy(kernel, { policyPath });
    assert.equal(state.locked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('policy-watchdog: once locked, stays locked on subsequent checks even without further changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-watchdog-'));
  try {
    const policyPath = path.join(dir, 'policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({ version: '1.0' }));
    const kernel = fakeKernel();
    checkPolicy(kernel, { policyPath });
    fs.writeFileSync(policyPath, JSON.stringify({ version: '1.1' }));
    checkPolicy(kernel, { policyPath }); // locks here
    fs.writeFileSync(policyPath, JSON.stringify({ version: '1.0' })); // reverted back
    const state = checkPolicy(kernel, { policyPath });
    assert.equal(state.locked, true, 'a circuit breaker does not silently un-latch when content reverts');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('policy-watchdog: checkPolicy locks (fails closed) when the policy file is unreadable', () => {
  const kernel = fakeKernel();
  const state = checkPolicy(kernel, { policyPath: '/definitely/does/not/exist/policy.json' });
  assert.equal(state.locked, true);
  assert.match(state.lockedReason, /unreadable/);
});

test('policy-watchdog: beforeTask blocks with blockedBy set once the watchdog is locked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-watchdog-'));
  try {
    const policyPath = path.join(dir, 'policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({ version: '1.0' }));
    const kernel = fakeKernel();
    // Prime the watchdog into a locked state directly, mirroring what a
    // real beforeTask sequence across a run would produce.
    const watchdogState = ensureWatchdogState(kernel);
    watchdogState.locked = true;
    watchdogState.lockedReason = 'trust policy changed mid-run (version 1.0 -> 1.1)';

    const data = { step: {}, state: {}, opts: {} };
    const result = policyWatchdog.beforeTask(kernel, data);
    assert.equal(result.blocked, true);
    assert.equal(result.blockedBy, 'policy-watchdog');
    assert.equal(result.blockReason, watchdogState.lockedReason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('policy-watchdog: run() reset clears the lock and forces a fresh baseline', () => {
  const kernel = fakeKernel();
  const watchdogState = ensureWatchdogState(kernel);
  watchdogState.locked = true;
  watchdogState.lockedReason = 'x';
  watchdogState.baselineHash = 'abc';

  const result = policyWatchdog.run(kernel, { action: 'reset' });
  assert.equal(result.ok, true);
  assert.equal(watchdogState.locked, false);
  assert.equal(watchdogState.baselineHash, null);
});

test('policy-watchdog: run() status reports the current state', () => {
  const kernel = fakeKernel();
  const result = policyWatchdog.run(kernel, { action: 'status' });
  assert.equal(result.ok, true);
  assert.equal(result.locked, false);
});

test('policy-watchdog: run() rejects an unsupported action', () => {
  const kernel = fakeKernel();
  const result = policyWatchdog.run(kernel, { action: 'nonsense' });
  assert.equal(result.ok, false);
});
