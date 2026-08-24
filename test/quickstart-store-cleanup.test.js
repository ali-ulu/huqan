'use strict';

/**
 * The quickstart store is documented as a throwaway. Evidence that it is
 * actually thrown away -- on the success path, on the setup-failure path, and
 * only after the store and kernel handles are closed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runQuickstartCommand } = require('../lib/quickstart-cli');

function makeDeps(overrides = {}) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-qs-cleanup-'));
  const order = [];
  const deps = {
    tmpdir,
    callTool: (kernel, request) => {
      if (request.name === 'huqan.learn') {
        return { ok: false, gate: { decision: 'review', reason: 'mutating_requires_review' }, approval: { id: 'approval-1' } };
      }
      if (request.name === 'huqan.approve') return { ok: true, data: { decision: 'approved' } };
      throw new Error(`unexpected tool ${request.name}`);
    },
    createApprovalStore: () => ({ close: () => order.push('store.close') }),
    createDemoKernel: (opts) => {
      order.push(`kernel.create:${path.dirname(opts.dbPath)}`);
      if (overrides.kernelThrows) throw new Error('kernel exploded');
      return {
        graph: {},
        verify: () => ({ data: { status: 'verified', confidence: 0.9 } }),
        close: () => order.push('kernel.close'),
      };
    },
    ...overrides.deps,
  };
  return { deps, tmpdir, order };
}

function storeDirs(tmpdir) {
  if (!fs.existsSync(tmpdir)) return [];
  return fs.readdirSync(tmpdir).filter((entry) => entry.startsWith('huqan-quickstart-'));
}

test('quickstart removes its throwaway store directory after a run', () => {
  const { deps, tmpdir } = makeDeps();
  try {
    const output = runQuickstartCommand(deps);

    assert.deepEqual(storeDirs(tmpdir), [], 'no huqan-quickstart-* directory may survive the run');
    assert.match(output, /removed after the run/);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('quickstart removes the store directory only after closing its handles', () => {
  const { deps, tmpdir, order } = makeDeps();
  try {
    runQuickstartCommand(deps);

    assert.ok(order.includes('store.close'), 'the approval store is closed');
    assert.ok(order.includes('kernel.close'), 'the demo kernel is closed');
    assert.deepEqual(storeDirs(tmpdir), []);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('quickstart removes the store directory when setup fails', () => {
  const { deps, tmpdir } = makeDeps({ kernelThrows: true });
  try {
    const output = runQuickstartCommand(deps);

    assert.match(output, /QUICKSTART_SETUP_FAILED/);
    assert.deepEqual(storeDirs(tmpdir), [], 'a failed run must not leak its directory either');
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('repeated quickstart runs leave nothing behind', () => {
  const { deps, tmpdir } = makeDeps();
  try {
    for (let i = 0; i < 3; i += 1) runQuickstartCommand(deps);

    assert.deepEqual(storeDirs(tmpdir), []);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});
