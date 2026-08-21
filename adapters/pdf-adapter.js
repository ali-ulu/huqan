const { contentHash, CONTENT_HASH_ALGORITHM } = require('../lib/content-hash');
const { learnEntriesSync } = require('./utils/learn-entries');
const fs = require('fs');
const path = require('path');
const { listFilesWithinRoot } = require('../lib/safe-file-walk');

function toAbs(p) {
  return path.resolve(String(p || ''));
}

const ALLOWED_PDF_EXTENSIONS = new Set(['.pdf']);
const PDF_LIMITS = Object.freeze({
  maxFiles: 100,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxPagesPerFile: 500,
  maxTotalPages: 2_000,
  maxTextItemsPerPage: 50_000,
  maxTextItemsPerFile: 500_000,
  maxOutputBytesPerFile: 5 * 1024 * 1024,
  maxTotalOutputBytes: 20 * 1024 * 1024,
  maxParseMillisecondsPerFile: 30_000,
});
// pdf.js validates this as a URL-shaped string, so it must use '/' even on
// Windows -- path.join's '\' separator makes it reject the value outright.
//
// Resolved on first use, not at require-time: this was the module's only
// load-time touch of pdfjs-dist, and it made a missing or half-installed
// pdfjs-dist take the whole adapter down with `Cannot find module
// 'pdfjs-dist/package.json'` -- before any caller had asked for a PDF. The
// library itself was already deferred (see loadPdfjs); this makes the pair
// consistent, so the failure now lands on the PDF call that needs it.
let standardFontDataUrlCache = null;
function standardFontDataUrl() {
  if (standardFontDataUrlCache === null) {
    standardFontDataUrlCache = `${path.join(
      path.dirname(require.resolve('pdfjs-dist/package.json')),
      'standard_fonts'
    ).split(path.sep).join('/')}/`;
  }
  return standardFontDataUrlCache;
}

function hasPdfExtension(filePath) {
  return ALLOWED_PDF_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function pdfError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function pdfLimits(options = {}) {
  const limits = {};
  for (const [name, fallback] of Object.entries(PDF_LIMITS)) {
    const value = options[name] === undefined ? fallback : options[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw pdfError('PDF_INVALID_LIMIT', `${name} must be a positive safe integer`);
    }
    limits[name] = value;
  }
  return limits;
}

function assertDeadline(deadline) {
  if (Date.now() > deadline) {
    throw pdfError('PDF_PARSE_TIMEOUT', 'PDF parse time limit exceeded');
  }
}

async function withinDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) assertDeadline(deadline);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(pdfError('PDF_PARSE_TIMEOUT', 'PDF parse time limit exceeded')),
          remaining,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let pdfjsLibPromise = null;
function loadPdfjs() {
  // pdfjs-dist ships ESM-only; this module stays CommonJS like every other
  // adapter, so the import is deferred and cached rather than done at
  // require-time.
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsLibPromise;
}

/**
 * Extracts text per page from a PDF buffer. Returns one entry per
 * non-empty page, mirroring json/yaml-adapter's flat entry model (a "page"
 * plays the role their top-level key plays). isEvalSupported is left at its
 * safe default (false) -- pdf.js never evaluates embedded JavaScript here,
 * only reads glyph/text layout.
 */
async function parsePdf(buffer, filePath = '', options = {}) {
  const limits = pdfLimits(options);
  const absPath = toAbs(filePath || '.');
  const inputBytes = Buffer.byteLength(buffer);
  if (inputBytes > limits.maxFileBytes) {
    throw pdfError('PDF_FILE_BYTES_LIMIT', 'PDF file byte limit exceeded', {
      filePath: absPath,
      limit: limits.maxFileBytes,
      actual: inputBytes,
    });
  }

  const deadline = Date.now() + limits.maxParseMillisecondsPerFile;
  const pdfjsLib = await loadPdfjs();
  assertDeadline(deadline);
  // pdf.js requires a plain Uint8Array (not a Buffer subclass instance),
  // so this always copies into one rather than passing Buffers through.
  const data = new Uint8Array(buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
  const loadingTask = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  });
  const doc = await withinDeadline(loadingTask.promise, deadline);

  if (doc.numPages > limits.maxPagesPerFile) {
    await loadingTask.destroy();
    throw pdfError('PDF_PAGE_LIMIT', 'PDF page limit exceeded', {
      filePath: absPath,
      limit: limits.maxPagesPerFile,
      actual: doc.numPages,
    });
  }

  const entries = [];
  let textItemCount = 0;
  let outputBytes = 0;
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      assertDeadline(deadline);
      const page = await withinDeadline(doc.getPage(pageNum), deadline);
      try {
        const content = await withinDeadline(page.getTextContent(), deadline);
        if (content.items.length > limits.maxTextItemsPerPage) {
          throw pdfError('PDF_TEXT_ITEM_LIMIT', 'PDF page text-item limit exceeded', {
            filePath: absPath,
            page: pageNum,
            limit: limits.maxTextItemsPerPage,
            actual: content.items.length,
          });
        }
        textItemCount += content.items.length;
        if (textItemCount > limits.maxTextItemsPerFile) {
          throw pdfError('PDF_TEXT_ITEM_LIMIT', 'PDF file text-item limit exceeded', {
            filePath: absPath,
            limit: limits.maxTextItemsPerFile,
            actual: textItemCount,
          });
        }
        const text = content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        outputBytes += Buffer.byteLength(text, 'utf8');
        if (outputBytes > limits.maxOutputBytesPerFile) {
          throw pdfError('PDF_OUTPUT_BYTES_LIMIT', 'PDF extracted-text byte limit exceeded', {
            filePath: absPath,
            limit: limits.maxOutputBytesPerFile,
            actual: outputBytes,
          });
        }
        entries.push({
          entryKey: `page-${pageNum}`,
          filePath: absPath,
          content: text,
          sourceRef: `file:${absPath}:page-${pageNum}`,
        });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  Object.defineProperty(entries, 'pageCount', { value: doc.numPages, enumerable: false });
  return entries;
}

function listPdfFiles(targetPath, options = {}) {
  return listFilesWithinRoot(targetPath, { ...options, matchesFile: hasPdfExtension });
}

async function ingestPdf(targetPath, options = {}) {
  const limits = pdfLimits(options);
  const files = listPdfFiles(targetPath, options);
  if (files.length > limits.maxFiles) {
    throw pdfError('PDF_FILE_COUNT_LIMIT', 'PDF file count limit exceeded', {
      limit: limits.maxFiles,
      actual: files.length,
    });
  }

  let totalBytes = 0;
  for (const filePath of files) {
    const bytes = fs.statSync(filePath).size;
    if (bytes > limits.maxFileBytes) {
      throw pdfError('PDF_FILE_BYTES_LIMIT', 'PDF file byte limit exceeded', {
        filePath,
        limit: limits.maxFileBytes,
        actual: bytes,
      });
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw pdfError('PDF_TOTAL_BYTES_LIMIT', 'PDF aggregate byte limit exceeded', {
        limit: limits.maxTotalBytes,
        actual: totalBytes,
      });
    }
  }

  const entries = [];
  const errors = [];
  let totalPages = 0;
  let totalOutputBytes = 0;
  for (const filePath of files) {
    const buffer = fs.readFileSync(filePath);
    try {
      const parsed = await parsePdf(buffer, filePath, limits);
      totalPages += parsed.pageCount;
      if (totalPages > limits.maxTotalPages) {
        throw pdfError('PDF_TOTAL_PAGE_LIMIT', 'PDF aggregate page limit exceeded', {
          limit: limits.maxTotalPages,
          actual: totalPages,
        });
      }
      totalOutputBytes += parsed.reduce(
        (sum, entry) => sum + Buffer.byteLength(entry.content, 'utf8'),
        0,
      );
      if (totalOutputBytes > limits.maxTotalOutputBytes) {
        throw pdfError('PDF_TOTAL_OUTPUT_BYTES_LIMIT', 'PDF aggregate extracted-text byte limit exceeded', {
          limit: limits.maxTotalOutputBytes,
          actual: totalOutputBytes,
        });
      }
      entries.push(...parsed);
    } catch (e) {
      if (typeof e?.code === 'string' && e.code.startsWith('PDF_')) throw e;
      errors.push({ filePath, error: e.message });
    }
  }
  return {
    files,
    entries,
    errors,
  };
}

async function ingestAndLearn(targetPath, kernel, options = {}) {
  const result = await ingestPdf(targetPath, options);
  return learnEntriesSync(result, kernel, options, 'document', 'pdf');
}

module.exports = {
  PDF_LIMITS,
  parsePdf,
  listPdfFiles,
  ingestPdf,
  ingestAndLearn,
  hasPdfExtension,
};
