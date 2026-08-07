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

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
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

// Receipt fields surfaced as a readable key/value block at the top of the
// PDF. Receipt shapes vary across admission paths, so each label falls back
// across the common field spellings rather than assuming one schema.
function stringifyField(value) {
  if (value === undefined || value === null) return '(none)';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function collectPdfFields(receipt) {
  const fields = [];
  const label = (names, display) => {
    for (const name of names) {
      if (receipt[name] !== undefined && receipt[name] !== null) {
        fields.push([display, stringifyField(receipt[name])]);
        return;
      }
    }
  };
  label(['receiptId', 'id'], 'Receipt ID');
  label(['timestamp', 'createdAt', 'exportedAt'], 'Timestamp');
  label(['decision', 'status', 'result'], 'Decision');
  if (receipt.valid !== undefined && receipt.valid !== null) {
    fields.push(['Valid', String(receipt.valid)]);
  }
  label(['sourceType', 'source'], 'Source Type');
  if (receipt.provenance !== undefined && receipt.provenance !== null) {
    fields.push(['Provenance', stringifyField(receipt.provenance)]);
  }
  return fields;
}

function renderReceiptPdf(doc, receipt) {
  doc
    .font('Helvetica-Bold').fontSize(18).fillColor('#111344')
    .text('Huqan Trust Receipt', doc.page.margins.left * 2, doc.page.margins.top * 2);
  doc.moveDown(0.5);
  doc
    .font('Helvetica').fontSize(9).fillColor('#666666')
    .text(`Exported ${new Date().toISOString()}`);
  doc.moveDown(1);

  for (const [label, value] of collectPdfFields(receipt)) {
    doc
      .font('Helvetica-Bold').fontSize(11).fillColor('#222222')
      .text(`${label}:  ${value}`);
    doc.moveDown(0.25);
  }

  doc.moveDown(1);
  doc
    .font('Helvetica-Bold').fontSize(12).fillColor('#111344')
    .text('Full Receipt (JSON)');
  doc.moveDown(0.5);
  doc
    .font('Courier').fontSize(8).fillColor('#333333')
    .text(JSON.stringify(receipt, null, 2));
}

// PDF writing is inherently streaming/async, so this resolves to the written
// file path once the underlying write stream has flushed. Same path-safety
// constraint as the JSON export: the output dir is validated against REPO_ROOT.
// Declared async so that even the synchronous path-resolution failure surfaces
// as a clean rejection rather than a synchronous throw.
async function exportReceiptToPdf(receipt, outputDir) {
  const resolvedDir = resolvePathWithinRoot(REPO_ROOT, outputDir, { allowMissing: true });
  fs.mkdirSync(resolvedDir, { recursive: true });
  const receiptId = receipt.receiptId || receipt.id || `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(resolvedDir, `${receiptId}.pdf`);

  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: `Huqan trust receipt ${receiptId}`, Author: 'huqan' },
  });

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    writeStream.on('finish', () => resolve(filePath));
    writeStream.on('error', reject);
    doc.on('error', reject);
    doc.pipe(writeStream);
    renderReceiptPdf(doc, receipt);
    doc.end();
  });
}

module.exports = {
  name: 'receipt-exporter',
  requires: [],
  optional: [],
  capabilities: [
    {
      name: 'receiptExporter',
      command: 'receipt-exporter',
      description: 'Exports learn() admission receipts to JSON or PDF files under receipts/.',
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
      const format = String(input.format || 'json').toLowerCase();
      const outputDir = input.outputDir || DEFAULT_OUTPUT_DIR;
      const recordExport = (filePath) => {
        state.exported.push({
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

module.exports._test = { ensureExporterState, exportReceiptToFile, exportReceiptToPdf, collectPdfFields, DEFAULT_OUTPUT_DIR };
