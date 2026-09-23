'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the actual fixture setup without npm, network or native builds.
const source = fs.readFileSync(path.join(__dirname, 'kernel-facade-contract.test.js'), 'utf8');
const setupSource = source.slice(source.indexOf('let INSTALL_DIR = null;'), source.indexOf('function runInstalledNode('));

function fixture(installResult) {
  const calls = [];
  const timeouts = [];
  const context = vm.createContext({
    assert, path, process, REPO_ROOT: __dirname,
    os: { tmpdir: () => __dirname },
    fs: { mkdirSync() {}, existsSync: () => true },
    cp: { spawnSync(command, args, options = {}) {
      calls.push(args[0]);
      timeouts.push([args[0], options.timeout]);
      if (args[0] === 'pack') return { status: 0, stdout: '[{"filename":"huqan.tgz"}]' };
      if (args[0] === 'init') return { status: 0 };
      return installResult;
    } },
  });
  vm.runInContext(setupSource, context);
  return {
    calls,
    timeouts,
    setup: () => vm.runInContext('setupTarballInstall()', context),
    create: platform => vm.runInContext(`createTarballInstall(${JSON.stringify(platform)})`, context),
  };
}

test('Windows tarball install gets bounded extra time without widening other platforms (#2803)', () => {
  const windows = fixture({ status: 0 });
  windows.create('win32');
  assert.deepEqual(windows.calls, ['pack', 'init', 'install']);
  assert.equal(windows.timeouts[2][1], 180_000);

  const linux = fixture({ status: 0 });
  linux.create('linux');
  assert.deepEqual(linux.calls, ['pack', 'init', 'install']);
  assert.equal(linux.timeouts[2][1], 120_000);
});

test('failed tarball installation is never reused as a ready package', () => {
  const f = fixture({ status: null, error: new Error('ETIMEDOUT'), stderr: 'install diagnostic' });
  let firstError;
  assert.throws(f.setup, error => { firstError = error; return /ETIMEDOUT/.test(error.message); });
  assert.throws(f.setup, error => error === firstError);
  assert.deepEqual(f.calls, ['pack', 'init', 'install']);
});

test('successful tarball installation is reused without another npm invocation', () => {
  const f = fixture({ status: 0 });
  const first = f.setup();
  assert.deepEqual(f.setup(), first);
  assert.deepEqual(f.calls, ['pack', 'init', 'install']);
});
