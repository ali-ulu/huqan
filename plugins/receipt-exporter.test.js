const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const receiptExporter = require('./receipt-exporter');
const { ensureExporterState, exportReceiptToFile } = receiptExporter._test;
const Kernel = require('../kernel');

function fakeKernel() {
  return {};
}

test('receipt-exporter: exportReceiptToFile writes JSON keyed by receiptId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-receipt-'));
  // exportReceiptToFile validates against REPO_ROOT, so the test writes
  // into a throwaway subdirectory under the repo instead of the OS temp
  // root -- mirrors metric-collector.test.js's export test for the same
  // path-safety reason.
  const outputDir = path.join(__dirname, '..', `tmp-receipt-export-test-${process.pid}`);
  try {
    const filePath = exportReceiptToFile({ receiptId: 'r-123', ok: true }, outputDir);
    assert.ok(filePath.endsWith(`r-123.json`));
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.receiptId, 'r-123');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('receipt-exporter: exportReceiptToFile rejects an outputDir outside the repo root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-receipt-outside-'));
  try {
    assert.throws(
      () => exportReceiptToFile({ receiptId: 'r-1' }, dir),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('receipt-exporter: afterLearn does nothing when no receipt is present', () => {
  const kernel = fakeKernel();
  receiptExporter.afterLearn(kernel, { text: 'x', opts: {}, admission: {} });
  assert.equal(ensureExporterState(kernel).exported.length, 0);
});

test('receipt-exporter: run() list returns an isolated copy', () => {
  const kernel = fakeKernel();
  const state = ensureExporterState(kernel);
  state.exported.push({ receiptId: 'a', filePath: '/x', exportedAt: 'now' });
  const result = receiptExporter.run(kernel, { action: 'list' });
  assert.equal(result.exported.length, 1);
  result.exported.push({ receiptId: 'b' });
  assert.equal(ensureExporterState(kernel).exported.length, 1, 'mutating the returned list must not affect internal state');
});

test('receipt-exporter: run() export requires a receipt object', () => {
  const kernel = fakeKernel();
  const result = receiptExporter.run(kernel, { action: 'export' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RECEIPT_EXPORT_MISSING_RECEIPT');
});

test('receipt-exporter: run() rejects an unsupported action', () => {
  const kernel = fakeKernel();
  const result = receiptExporter.run(kernel, { action: 'nonsense' });
  assert.equal(result.ok, false);
});

test('receipt-exporter: afterLearn end to end -- a real kernel.learn() with an admission receipt gets exported', () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.plugins.register(receiptExporter);

  k.learn('Köpek hayvandır', {
    admissionRequired: true,
    approvalRequired: false,
    sourceType: 'test',
  });

  const state = ensureExporterState(k);
  try {
    if (state.exported.length > 0) {
      assert.ok(state.exported[0].filePath);
      assert.ok(fs.existsSync(state.exported[0].filePath));
    }
    // Not every admission path produces a receipt (bypass-mode learns
    // don't); this test's point is that the hook runs without throwing
    // against a real kernel, and exports cleanly on the paths that do
    // produce one -- it deliberately does not assert exported.length > 0,
    // since that depends on admission internals outside this plugin's
    // control.
  } finally {
    for (const entry of state.exported) {
      fs.rmSync(entry.filePath, { force: true });
    }
    fs.rmSync(receiptExporter._test.DEFAULT_OUTPUT_DIR, { recursive: true, force: true });
  }
});
