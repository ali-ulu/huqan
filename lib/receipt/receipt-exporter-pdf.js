'use strict';

const fs = require('fs');
const path = require('path');
const { createPathError } = require('../path-safety');
const { defaultOutputDir, resolveExportRoot, resolveReceiptTarget } = require('./receipt-exporter-paths');

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
// constraint as the JSON export: repo-contained dirs stay inside receipts/,
// outside-repo dirs under the user-data/tmp/cwd boundary (H-09, #1982).
// Declared async so that even the synchronous path-resolution failure surfaces
// as a clean rejection rather than a synchronous throw.
async function exportReceiptToPdf(receipt, outputDir) {
  const exportRoot = resolveExportRoot(outputDir || defaultOutputDir());
  const filePath = resolveReceiptTarget(receipt, outputDir, 'pdf');
  const receiptId = path.basename(filePath, '.pdf');

  const PDFDocument = loadPdfDocument();
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: `Huqan trust receipt ${receiptId}`, Author: 'huqan' },
  });

  return new Promise((resolve, reject) => {
    // Exclusive create, same as the JSON writer: a second export for the
    // same target must fail, not silently overwrite (#1280).
    const writeStream = fs.createWriteStream(filePath, { flags: 'wx' });
    writeStream.on('finish', () => resolve(filePath));
    writeStream.on('error', (error) => {
      if (error && error.code === 'EEXIST') {
        reject(createPathError('RECEIPT_EXPORT_TARGET_EXISTS', 'receipt export target already exists', exportRoot, filePath));
        return;
      }
      reject(error);
    });
    doc.on('error', reject);
    doc.pipe(writeStream);
    renderReceiptPdf(doc, receipt);
    doc.end();
  });
}

module.exports = { collectPdfFields, exportReceiptToPdf };
