'use strict';

// H-10 (#1983): plugins/decision-explainer.js lived in the repo but outside
// `package.json` files, so `npm pack` silently dropped it and the installed
// package lost the `explain` capability while every source-tree test stayed
// green. These pin the installed-package claim: the manifest lists both
// files, the packed tarball contains them, and the capability runs end to
// end through runCapability('explain').
//
// The full pack-and-install consumer proof lives in
// scripts/verify-package-tarball.js (verifyDecisionExplainer); these are the
// fast static halves that fail in seconds rather than minutes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSyncWindowsAware } = require('../scripts/spawn-windows-aware');

const REPO_ROOT = path.resolve(__dirname, '..');
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const EXPLAIN_FILES = [
  'plugins/decision-explainer.js',
  'plugins/decision-explainer.manifest.json',
];

test('package.json files lists the decision-explainer plugin and its manifest', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const file of EXPLAIN_FILES) {
    assert.ok(pkg.files.includes(file), `${file} must be in package.json#files`);
  }
});

test('the packed tarball contains the decision-explainer files', () => {
  const packed = spawnSyncWindowsAware(NPM_COMMAND, ['pack', '--dry-run'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const output = `${packed.stdout || ''}${packed.stderr || ''}`;
  assert.equal(packed.status, 0, `npm pack --dry-run failed:\n${output.slice(-1000)}`);
  for (const file of EXPLAIN_FILES) {
    assert.ok(output.includes(file), `tarball must list ${file}`);
  }
});

test('runCapability explain resolves through the plugin manager', async () => {
  const Kernel = require('../kernel');
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.enableCapability('pluginCapabilities');
  k.usePlugin(require('../plugins/decision-explainer'));
  const result = await k.runCapability('explain', {
    decision: { decision: 'allow', reason: 'read_only_allow' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.capability, 'explain');
  assert.equal(
    result.data.explanation,
    'İzin verildi: Salt-okunur bir işlem olduğu için izin verildi.',
  );
});
