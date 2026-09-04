'use strict';

/**
 * The suite must not read, or write to, the operator's live gate state (#1846).
 *
 * Two halves, because either alone is satisfiable without the property holding:
 * the resolver has to expose one redirectable state root, and the runner the
 * suite is actually started with has to point at a throwaway one -- including
 * when the developer's own shell exports the narrower overrides.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defaultExternalActionStateRoot, defaultExternalActionReceiptPath } = require('../lib/external-action-receipt');
const { defaultExternalActionPolicyPath } = require('../lib/external-action-command-policy');

const REPO_ROOT = path.resolve(__dirname, '..');

function scratch(t, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test('one variable redirects the whole of the gate state', () => {
  const root = path.join(os.tmpdir(), 'huqan-state-root-probe');
  const environment = { HUQAN_STATE_ROOT: root };
  assert.equal(defaultExternalActionStateRoot(environment), path.resolve(root));
  assert.equal(defaultExternalActionReceiptPath(environment), path.join(path.resolve(root), 'external-action-receipts.jsonl'));
  assert.equal(defaultExternalActionPolicyPath(environment), path.join(path.resolve(root), 'external-action-policy.json'));
});

test('a deployment that named its own trail keeps it', () => {
  const root = path.join(os.tmpdir(), 'huqan-state-root-probe');
  const trail = path.join(os.tmpdir(), 'deployment', 'receipts.jsonl');
  const environment = { HUQAN_STATE_ROOT: root, HUQAN_EXTERNAL_GUARD_RECEIPTS: trail };
  assert.equal(defaultExternalActionReceiptPath(environment), path.resolve(trail));
  assert.equal(defaultExternalActionPolicyPath(environment), path.join(path.dirname(path.resolve(trail)), 'external-action-policy.json'));
});

test('the test runner points the suite away from the operator live state', t => {
  const home = scratch(t, 'huqan-fake-operator-home-');
  const liveRoot = path.join(home, 'huqan');
  // The live state a developer machine would have: a narrow allowlist and an
  // existing receipt chain. A test that reads either has broken the property.
  fs.mkdirSync(liveRoot, { recursive: true });
  fs.writeFileSync(path.join(liveRoot, 'external-action-policy.json'), JSON.stringify(['npm test']), 'utf8');
  fs.writeFileSync(path.join(liveRoot, 'external-action-receipts.jsonl'), '{"receiptId":"pre-existing"}\n', 'utf8');
  const before = fs.readFileSync(path.join(liveRoot, 'external-action-receipts.jsonl'), 'utf8');

  const out = path.join(home, 'probe.json');
  // This test is itself running under `node --test`, which marks its children
  // with NODE_TEST_CONTEXT. Inherited, that variable makes the nested runner
  // report into this run instead of executing the probe.
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (name.startsWith('NODE_TEST')) delete inherited[name];
  }
  const run = spawnSync(process.execPath, ['scripts/run-tests.js', 'test/helpers/gate-state-sandbox-probe.js'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...inherited,
      HUQAN_GATE_STATE_PROBE_OUT: out,
      LOCALAPPDATA: home,
      HOME: home,
      USERPROFILE: home,
      // Exported in the developer's shell, aimed at the real trail. The runner
      // is expected to drop these rather than hand them to the suite.
      HUQAN_EXTERNAL_GUARD_RECEIPTS: path.join(liveRoot, 'external-action-receipts.jsonl'),
      HUQAN_EXTERNAL_GUARD_POLICY: path.join(liveRoot, 'external-action-policy.json'),
      HUQAN_STATE_ROOT: '',
    },
  });
  assert.equal(run.status, 0, `${run.stdout || ''}${run.stderr || ''}`);

  const observed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(observed.receiptOverride, null);
  assert.equal(observed.policyOverride, null);
  assert.ok(observed.stateRoot, 'the runner set no state root');
  assert.equal(path.dirname(observed.receiptPath), path.resolve(observed.stateRoot));
  assert.equal(path.dirname(observed.policyPath), path.resolve(observed.stateRoot));
  assert.ok(!observed.receiptPath.startsWith(liveRoot), `suite resolved the live trail: ${observed.receiptPath}`);
  assert.ok(!observed.policyPath.startsWith(liveRoot), `suite resolved the live policy: ${observed.policyPath}`);

  assert.equal(fs.readFileSync(path.join(liveRoot, 'external-action-receipts.jsonl'), 'utf8'), before);
  assert.equal(fs.existsSync(observed.stateRoot), false, 'the sandbox state root outlived the run');
});
