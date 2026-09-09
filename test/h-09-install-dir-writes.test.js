'use strict';

// H-09 (#1982): export artefacts must not require a writable install dir.
// Defaults live under the user-data state root; explicit tmp/cwd targets are
// accepted; traversal protection (SAFE_RECEIPT_ID, exclusive wx, export-root
// bounding) stays intact.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const receiptExporter = require('../plugins/receipt-exporter');
const metricCollector = require('../plugins/metric-collector');

const REPO_ROOT = path.join(__dirname, '..');

function outsideRepo(p) {
  const relative = path.relative(REPO_ROOT, path.resolve(p));
  return relative === '' ? false : relative.startsWith('..') || path.isAbsolute(relative);
}

test('H-09: default outputs live outside the install dir (read-only-install assumption)', () => {
  assert.ok(outsideRepo(receiptExporter._test.defaultOutputDir()),
    `receipt default must not be under the repo: ${receiptExporter._test.defaultOutputDir()}`);
  assert.ok(outsideRepo(metricCollector._test.defaultOutputPath()),
    `telemetry default must not be under the repo: ${metricCollector._test.defaultOutputPath()}`);
});

test('H-09: defaults honour HUQAN_STATE_ROOT', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'h09-state-root-'));
  const previous = process.env.HUQAN_STATE_ROOT;
  process.env.HUQAN_STATE_ROOT = sandbox;
  try {
    assert.equal(receiptExporter._test.defaultOutputDir(), path.join(sandbox, 'receipts'));
    assert.equal(metricCollector._test.defaultOutputPath(), path.join(sandbox, 'gate-telemetry.json'));
  } finally {
    if (previous === undefined) delete process.env.HUQAN_STATE_ROOT;
    else process.env.HUQAN_STATE_ROOT = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('H-09: receipt JSON export to tmp succeeds without touching the install dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h09-receipt-tmp-'));
  try {
    const filePath = receiptExporter._test.exportReceiptToFile({ receiptId: 'h09-tmp-1', ok: true }, dir);
    assert.ok(filePath.endsWith('h09-tmp-1.json'));
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).receiptId, 'h09-tmp-1');
    assert.ok(outsideRepo(filePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H-09: receipt PDF export to tmp succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h09-receipt-pdf-tmp-'));
  try {
    const filePath = await receiptExporter._test.exportReceiptToPdf({ receiptId: 'h09-pdf-1' }, dir);
    assert.equal(fs.readFileSync(filePath).subarray(0, 5).toString('ascii'), '%PDF-');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H-09: metric export to tmp succeeds via run()', () => {
  const kernel = {};
  metricCollector.afterGateDecision(kernel, { source: 'h09', decision: 'allow' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h09-metric-tmp-'));
  try {
    const result = metricCollector.run(kernel, { action: 'export', outputPath: path.join(dir, 'gate-telemetry.json') });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(result.outputPath, 'utf8')).total, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H-09: receipt export under an outside-repo cwd succeeds', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'h09-cwd-'));
  const previousCwd = process.cwd();
  process.chdir(workdir);
  try {
    const target = path.join(workdir, 'out');
    const filePath = receiptExporter._test.exportReceiptToFile({ receiptId: 'h09-cwd-1' }, target);
    assert.equal(path.dirname(filePath), path.resolve(target));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('H-09: default export (no outputDir/outputPath) succeeds and stays outside the repo', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'h09-default-export-'));
  const previous = process.env.HUQAN_STATE_ROOT;
  process.env.HUQAN_STATE_ROOT = sandbox;
  const kernel = {};
  try {
    const receiptResult = receiptExporter.run(kernel, {
      action: 'export',
      receipt: { receiptId: 'h09-default-1', ok: true },
    });
    assert.equal(receiptResult.ok, true);
    assert.ok(outsideRepo(receiptResult.filePath));
    assert.ok(fs.existsSync(receiptResult.filePath));

    metricCollector.afterGateDecision(kernel, { source: 'h09', decision: 'allow' });
    const metricResult = metricCollector.run(kernel, { action: 'export' });
    assert.equal(metricResult.ok, true);
    assert.ok(outsideRepo(metricResult.outputPath));
    assert.ok(fs.existsSync(metricResult.outputPath));
  } finally {
    if (previous === undefined) delete process.env.HUQAN_STATE_ROOT;
    else process.env.HUQAN_STATE_ROOT = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('H-09: traversal rejection is preserved -- unsafe receiptId fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h09-traversal-'));
  try {
    for (const receiptId of ['../escaped', '..', 'a/b', 'has space', 'x'.repeat(129)]) {
      assert.throws(
        () => receiptExporter._test.exportReceiptToFile({ receiptId }, dir),
        (e) => e.code === 'RECEIPT_EXPORT_INVALID_RECEIPT_ID',
        `expected ${JSON.stringify(receiptId)} to be rejected`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H-09: traversal rejection is preserved -- repo-root outputDir and package.json target rejected', () => {
  assert.throws(
    () => receiptExporter._test.exportReceiptToFile({ receiptId: 'package' }, REPO_ROOT),
    (e) => e.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
  );
  const kernel = {};
  metricCollector.afterGateDecision(kernel, { source: 'h09', decision: 'allow' });
  const result = metricCollector.run(kernel, {
    action: 'export',
    outputPath: path.join(REPO_ROOT, 'package.json'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PATH_OUTSIDE_ALLOWED_ROOT');
});

test('H-09: exclusive create is preserved -- second tmp export to the same target fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h09-exclusive-'));
  try {
    receiptExporter._test.exportReceiptToFile({ receiptId: 'h09-excl-1', decision: 'first' }, dir);
    assert.throws(
      () => receiptExporter._test.exportReceiptToFile({ receiptId: 'h09-excl-1', decision: 'second' }, dir),
      (e) => e.code === 'RECEIPT_EXPORT_TARGET_EXISTS',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
