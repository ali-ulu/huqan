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
 * Scope cut: JSON export only, not PDF as #212 also asked for. Generating
 * a PDF needs a PDF-*writing* library (pdfjs-dist, already a dependency,
 * only reads/parses PDFs -- see adapters/pdf-adapter.js) -- a new
 * dependency addition is its own decision, the same kind of call already
 * made explicitly for js-yaml and pdfjs-dist rather than folded silently
 * into an unrelated plugin PR.
 */

const fs = require('fs');
const path = require('path');
const { resolvePathWithinRoot } = require('../lib/path-safety');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, 'receipts');

function ensureExporterState(kernel) {
  if (!kernel._receiptExporterState) {
    kernel._receiptExporterState = { exported: [] };
  }
  return kernel._receiptExporterState;
}

function exportReceiptToFile(receipt, outputDir) {
  const resolvedDir = resolvePathWithinRoot(REPO_ROOT, outputDir, { allowMissing: true });
  fs.mkdirSync(resolvedDir, { recursive: true });
  const receiptId = receipt.receiptId || receipt.id || `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(resolvedDir, `${receiptId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2));
  return filePath;
}

module.exports = {
  name: 'receipt-exporter',
  requires: [],
  optional: [],
  capabilities: [
    {
      name: 'receiptExporter',
      command: 'receipt-exporter',
      description: 'Exports learn() admission receipts to JSON files under receipts/.',
    },
  ],

  afterLearn(kernel, data) {
    const receipt = data && data.admission && data.admission.receipt;
    if (!receipt || typeof receipt !== 'object') return;

    try {
      const filePath = exportReceiptToFile(receipt, DEFAULT_OUTPUT_DIR);
      const state = ensureExporterState(kernel);
      state.exported.push({
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
      try {
        const outputDir = input.outputDir || DEFAULT_OUTPUT_DIR;
        const filePath = exportReceiptToFile(input.receipt, outputDir);
        state.exported.push({
          receiptId: input.receipt.receiptId || input.receipt.id || null,
          filePath,
          exportedAt: new Date().toISOString(),
        });
        return { ok: true, filePath };
      } catch (e) {
        return { ok: false, error: e.message, code: e.code || 'RECEIPT_EXPORT_FAILED' };
      }
    }

    return { ok: false, error: `Unsupported receipt-exporter action: ${action}` };
  },
};

module.exports._test = { ensureExporterState, exportReceiptToFile, DEFAULT_OUTPUT_DIR };
