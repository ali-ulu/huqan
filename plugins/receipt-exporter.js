'use strict';

/**
 * receipt-exporter (#212).
 *
 * afterLearn hook: exports a learn() call's admission receipt to a JSON
 * file under receipts/, when one exists. Depends on the afterLearn payload
 * carrying `admission.receipt` -- previously absent entirely (only present
 * on learn()'s own return value, never passed to any plugin hook), added
 * alongside this plugin in lib/learn-use-case.js.
 *
 * Only fires when a receipt is actually present: "Bypass-mode and
 * admission-free learns produce no admission receipt at all" (kernel.js's
 * own comment on the matter) -- the receipt's presence is itself the
 * signal that this learn went through real admission processing, so no
 * separate "was this approved" check is needed on top of it.
 *
 * JSON export only was the original scope cut for #212; PDF export (also
 * part of #212, tracked here as #352) is layered on top without touching
 * the JSON path. Generating a PDF needs a PDF-*writing* library -- pdfjs-dist
 * (already a dependency) only reads/parses PDFs (see adapters/pdf-adapter.js).
 *
 * Deliberate dependency decision: `pdfkit` (^0.19.1) was chosen over the
 * alternatives the same way js-yaml and pdfjs-dist were chosen before --
 * as its own explicit call rather than folded silently into a plugin PR.
 *  - pdfkit: pure-JS, no native compile step (zero native deps), popular
 *    and actively maintained, deterministic glyph rendering from built-in
 *    AFM fonts (no external font file needed), and a tiny API surface for
 *    the key/value + JSON-dump layout used here.
 *  - Alternatives rejected: `pdf-lib` (lower-level, needs manual font/metrics
 *    wiring to render text reliably), `@react-pdf/renderer` (React dependency
 *    for a headless export path), `puppeteer`/`playwright` (full browser fork
 *    to print-to-PDF -- far too heavy), and `html-pdf` (pulls in a full
 *    Chromium). pdfkit's zero-native, headless, pure-JS profile is the
 *    minimal fit for an in-process plugin export.
 */

const { defaultOutputDir, resolveExportRoot, resolveReceiptFileStem, exportReceiptToFile, DEFAULT_OUTPUT_DIR, DEV_RECEIPTS_ROOT } = require('../lib/receipt/receipt-exporter-paths');
const { collectPdfFields, exportReceiptToPdf } = require('../lib/receipt/receipt-exporter-pdf');

// Formats this exporter can actually produce. Anything else fails closed
// rather than silently falling through to the JSON writer while reporting
// the requested format back to the caller (#544).
const SUPPORTED_FORMATS = Object.freeze(['json', 'pdf']);

// kernel._receiptExporterState lives for the process's lifetime; without a
// cap, state.exported grows by one entry per learn() with a receipt for as
// long as a long-running server keeps running (#1280).
const MAX_EXPORTED_HISTORY = 1000;

function ensureExporterState(kernel) {
  if (!kernel._receiptExporterState) {
    kernel._receiptExporterState = { exported: [] };
  }
  return kernel._receiptExporterState;
}

function recordExported(state, entry) {
  state.exported.push(entry);
  if (state.exported.length > MAX_EXPORTED_HISTORY) {
    state.exported.splice(0, state.exported.length - MAX_EXPORTED_HISTORY);
  }
}

module.exports = {
  name: 'receipt-exporter',
  requires: [],
  optional: [],
  capabilities: [
    {
      name: 'receiptExporter',
      command: 'receipt-exporter',
      description: 'Exports learn() admission receipts to JSON or PDF files under the user-data receipts dir (repo receipts/ as dev fallback).',
    },
  ],

  afterLearn(kernel, data) {
    const receipt = data && data.admission && data.admission.receipt;
    if (!receipt || typeof receipt !== 'object') return;

    try {
      const filePath = exportReceiptToFile(receipt, defaultOutputDir());
      const state = ensureExporterState(kernel);
      recordExported(state, {
        receiptId: receipt.receiptId || receipt.id || null,
        filePath,
        exportedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error(`[receipt-exporter] export failed: ${e.message}`);
    }
  },

  run(kernel, input = {}) {
    const action = String(input.action || 'list').toLowerCase();
    const state = ensureExporterState(kernel);

    if (action === 'list') {
      return { ok: true, exported: [...state.exported] };
    }

    if (action === 'export') {
      if (!input.receipt || typeof input.receipt !== 'object') {
        return { ok: false, error: 'a receipt object is required', code: 'RECEIPT_EXPORT_MISSING_RECEIPT' };
      }
      const format = String(input.format || 'json').toLowerCase();
      // Fail closed on unknown formats (#544). Previously every non-'pdf'
      // value fell through to the JSON writer while `recordExport` echoed the
      // requested format back, so `format: 'yaml'` reported ok:true with
      // format 'yaml' next to a file that was actually JSON.
      if (!SUPPORTED_FORMATS.includes(format)) {
        return {
          ok: false,
          error: `Unsupported receipt-exporter format: ${format}`,
          code: 'RECEIPT_EXPORT_UNSUPPORTED_FORMAT',
          supportedFormats: [...SUPPORTED_FORMATS],
        };
      }
      const outputDir = input.outputDir || defaultOutputDir();
      const recordExport = (filePath) => {
        recordExported(state, {
          receiptId: input.receipt.receiptId || input.receipt.id || null,
          filePath,
          format,
          exportedAt: new Date().toISOString(),
        });
        return { ok: true, filePath, format };
      };
      try {
        // PDF generation is streaming/async; the returned promise resolves
        // to the { ok, filePath, format } record once the file is flushed.
        if (format === 'pdf') {
          return exportReceiptToPdf(input.receipt, outputDir)
            .then(recordExport)
            .catch((e) => ({ ok: false, error: e.message, code: e.code || 'RECEIPT_EXPORT_FAILED' }));
        }
        // default: JSON -- unchanged behaviour, format recorded for clarity.
        return recordExport(exportReceiptToFile(input.receipt, outputDir));
      } catch (e) {
        return { ok: false, error: e.message, code: e.code || 'RECEIPT_EXPORT_FAILED' };
      }
    }

    return { ok: false, error: `Unsupported receipt-exporter action: ${action}` };
  },
};

module.exports._test = {
  ensureExporterState,
  exportReceiptToFile,
  exportReceiptToPdf,
  collectPdfFields,
  resolveReceiptFileStem,
  recordExported,
  defaultOutputDir,
  resolveExportRoot,
  DEFAULT_OUTPUT_DIR,
  DEV_RECEIPTS_ROOT,
  // Back-compat alias: the repo checkout's receipts/ dev-fallback root.
  RECEIPTS_ROOT: DEV_RECEIPTS_ROOT,
  MAX_EXPORTED_HISTORY,
  SUPPORTED_FORMATS,
};
