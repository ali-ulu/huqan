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

/**
 * Loaded on first PDF export, not at require-time.
 *
 * A top-level require made the whole plugin unloadable when pdfkit was absent
 * -- the kernel printed `Plugin failed to load: receipt-exporter.js` at every
 * start, and the plugin's JSON export, which needs nothing from pdfkit, went
 * down with it. Deferring puts the failure on the one call that cannot work
 * without it.
 */
let PDFDocumentCache = null;
function loadPdfDocument() {
  if (PDFDocumentCache === null) {
    try {
      PDFDocumentCache = require('pdfkit');
    } catch (cause) {
      const error = new Error(
        'PDF receipt export needs pdfkit, which is not installed. Install it with '
        + '`npm install pdfkit`, or export the receipt as JSON instead.',
      );
      error.code = 'HUQAN_PDF_EXPORT_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
  }
  return PDFDocumentCache;
}
const { createPathError, isPathWithinRoot, resolvePathWithinRoot } = require('../lib/path-safety');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, 'receipts');

// Formats this exporter can actually produce. Anything else fails closed
// rather than silently falling through to the JSON writer while reporting
// the requested format back to the caller (#544).
const SUPPORTED_FORMATS = Object.freeze(['json', 'pdf']);

// The receiptId doubles as the output file name, so it is constrained to a
// single safe path segment. Real receipt ids are already generated from this
// alphabet (`apr_receipt_<hash>`, `madm_receipt_<sha1>`,
// `external_candidate_receipt_<sha256>`), so this rejects attacker-shaped
// input without narrowing any legitimate id.
const MAX_RECEIPT_ID_LEN = 128;
const SAFE_RECEIPT_ID = /^[A-Za-z0-9._-]+$/;

function ensureExporterState(kernel) {
  if (!kernel._receiptExporterState) {
    kernel._receiptExporterState = { exported: [] };
  }
  return kernel._receiptExporterState;
}

/**
 * Resolve the file-name stem for a receipt, fail-closed (#543).
 *
 * `outputDir` is validated against REPO_ROOT, but the file name was previously
 * interpolated straight from `receipt.receiptId || receipt.id`, so a value like
 * `../package` escaped the receipts/ directory and overwrote unrelated repo
 * files. The id is now required to be a single safe path segment; a missing id
 * still falls back to a generated one, but a *present but unsafe* id is an
 * error rather than something quietly rewritten to a different target.
 */
function resolveReceiptFileStem(receipt) {
  const raw = receipt.receiptId || receipt.id;
  if (raw === undefined || raw === null || raw === '') {
    return `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const candidate = String(raw).trim();
  const isSafeSegment = Boolean(candidate)
    && candidate.length <= MAX_RECEIPT_ID_LEN
    && SAFE_RECEIPT_ID.test(candidate)
    // `.` and `..` match the alphabet above but are directory references.
    && !/^\.+$/.test(candidate);

  if (!isSafeSegment) {
    throw createPathError(
      'RECEIPT_EXPORT_INVALID_RECEIPT_ID',
      'receiptId is not a safe file name segment',
      REPO_ROOT,
      candidate,
    );
  }
  return candidate;
}

/**
 * Resolve the output directory and the final file path together, so the
 * REPO_ROOT boundary is enforced against the path actually written -- not just
 * against the directory it was meant to land in.
 */
function resolveReceiptTarget(receipt, outputDir, extension) {
  const resolvedDir = resolvePathWithinRoot(REPO_ROOT, outputDir, { allowMissing: true });
  const stem = resolveReceiptFileStem(receipt);
  const filePath = path.join(resolvedDir, `${stem}.${extension}`);

  // Defence in depth: the stem is already a validated single segment, so this
  // should be unreachable -- it exists so any future loosening of the stem
  // rules still cannot write outside the resolved directory.
  if (path.dirname(filePath) !== resolvedDir || !isPathWithinRoot(REPO_ROOT, filePath)) {
    throw createPathError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      'Path escapes allowed root',
      REPO_ROOT,
      filePath,
    );
  }

  fs.mkdirSync(resolvedDir, { recursive: true });
  return filePath;
}

function exportReceiptToFile(receipt, outputDir) {
  const filePath = resolveReceiptTarget(receipt, outputDir, 'json');
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
  const filePath = resolveReceiptTarget(receipt, outputDir, 'pdf');
  const receiptId = path.basename(filePath, '.pdf');

  const PDFDocument = loadPdfDocument();
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

module.exports._test = {
  ensureExporterState,
  exportReceiptToFile,
  exportReceiptToPdf,
  collectPdfFields,
  resolveReceiptFileStem,
  DEFAULT_OUTPUT_DIR,
  SUPPORTED_FORMATS,
};
