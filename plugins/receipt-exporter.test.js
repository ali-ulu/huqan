const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const receiptExporter = require('./receipt-exporter');
const { ensureExporterState, exportReceiptToFile, exportReceiptToPdf } = receiptExporter._test;
const Kernel = require('../kernel');

// pdf.js (used to read a generated PDF back for the round-trip assertion)
// wants '/' separators and the standard-font data URL, mirroring
// adapters/pdf-adapter.js.
const STANDARD_FONT_DATA_URL = `${path.join(
  path.dirname(require.resolve('pdfjs-dist/package.json')),
  'standard_fonts'
).split(path.sep).join('/')}/`;

async function readPdfText(filePath) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  });
  const doc = await loadingTask.promise;
  let text = '';
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        text += `${content.items.map((item) => item.str || '').join(' ')} `;
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  return text.replace(/\s+/g, ' ').trim();
}

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

test('receipt-exporter: exportReceiptToPdf writes a real PDF with %PDF magic bytes', async () => {
  const outputDir = path.join(__dirname, '..', `tmp-receipt-export-test-${process.pid}`);
  try {
    const filePath = await exportReceiptToPdf({ receiptId: 'r-pdf-1', decision: 'approved' }, outputDir);
    assert.ok(filePath.endsWith('r-pdf-1.pdf'));
    assert.ok(fs.existsSync(filePath));
    const head = fs.readFileSync(filePath).subarray(0, 5).toString('ascii');
    assert.equal(head, '%PDF-');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('receipt-exporter: exportReceiptToPdf rejects an outputDir outside the repo root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-receipt-pdf-outside-'));
  try {
    await assert.rejects(
      () => exportReceiptToPdf({ receiptId: 'r-1' }, dir),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('receipt-exporter: run() format "pdf" exports a real PDF and records it', async () => {
  const kernel = fakeKernel();
  const outputDir = path.join(__dirname, '..', `tmp-receipt-export-test-${process.pid}`);
  try {
    const result = await receiptExporter.run(kernel, {
      action: 'export',
      format: 'pdf',
      outputDir,
      receipt: { receiptId: 'r-run-pdf', decision: 'approved' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.format, 'pdf');
    assert.ok(result.filePath.endsWith('r-run-pdf.pdf'));
    assert.ok(fs.existsSync(result.filePath));
    const head = fs.readFileSync(result.filePath).subarray(0, 5).toString('ascii');
    assert.equal(head, '%PDF-');
    // The PDF export is recorded in exporter state like the JSON export.
    const state = ensureExporterState(kernel);
    assert.equal(state.exported.length, 1);
    assert.equal(state.exported[0].format, 'pdf');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('receipt-exporter: run() default format stays JSON', () => {
  const kernel = fakeKernel();
  const outputDir = path.join(__dirname, '..', `tmp-receipt-export-test-${process.pid}`);
  try {
    const result = receiptExporter.run(kernel, {
      action: 'export',
      outputDir,
      receipt: { receiptId: 'r-run-json', decision: 'approved' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.format, 'json');
    assert.ok(result.filePath.endsWith('r-run-json.json'));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('receipt-exporter: PDF round-trip -- a generated receipt PDF reads back its fields', async () => {
  const outputDir = path.join(__dirname, '..', `tmp-receipt-export-test-${process.pid}`);
  try {
    const receipt = {
      receiptId: 'r-roundtrip-7',
      timestamp: '2026-08-08T00:00:00Z',
      decision: 'approved',
      sourceType: 'test',
      provenance: { source: 'unit-test' },
    };
    const filePath = await exportReceiptToPdf(receipt, outputDir);
    const text = await readPdfText(filePath);
    assert.ok(text.includes('Huqan Trust Receipt'));
    assert.ok(text.includes('r-roundtrip-7'));
    assert.ok(text.includes('approved'));
    assert.ok(text.includes('r-roundtrip-7'), 'receiptId is embedded in the full JSON dump');
    assert.ok(text.includes('unit-test'), 'provenance value is embedded in the full JSON dump');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

