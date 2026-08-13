const { contentHash, CONTENT_HASH_ALGORITHM } = require('../lib/content-hash');
const fs = require('fs');
const path = require('path');
const { resolvePathWithinRoot } = require('../lib/path-safety');

function toAbs(p) {
  return path.resolve(String(p || ''));
}

const ALLOWED_PDF_EXTENSIONS = new Set(['.pdf']);
// pdf.js validates this as a URL-shaped string, so it must use '/' even on
// Windows -- path.join's '\' separator makes it reject the value outright.
const STANDARD_FONT_DATA_URL = `${path.join(
  path.dirname(require.resolve('pdfjs-dist/package.json')),
  'standard_fonts'
).split(path.sep).join('/')}/`;

function hasPdfExtension(filePath) {
  return ALLOWED_PDF_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
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
async function parsePdf(buffer, filePath = '') {
  const absPath = toAbs(filePath || '.');
  const pdfjsLib = await loadPdfjs();
  // pdf.js requires a plain Uint8Array (not a Buffer subclass instance),
  // so this always copies into one rather than passing Buffers through.
  const data = new Uint8Array(buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
  const loadingTask = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  });
  const doc = await loadingTask.promise;

  const entries = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
        if (!text) continue;
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
    // The doc proxy itself has no destroy(); the loading task owns teardown
    // of the worker/transport it created.
    await loadingTask.destroy();
  }

  return entries;
}

function listPdfFiles(targetPath, options = {}) {
  const rootPath = options.rootPath || options.allowedRoot || options.workspaceRoot;
  if (!rootPath) {
    throw new Error('rootPath is required');
  }

  const absRoot = path.resolve(String(rootPath));
  const absTarget = resolvePathWithinRoot(absRoot, targetPath, { allowMissing: true });
  if (!fs.existsSync(absTarget)) return [];

  const stat = fs.lstatSync(absTarget);
  const files = [];

  const walk = (dir) => {
    const resolvedDir = resolvePathWithinRoot(absRoot, dir);
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true })
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absEntry = path.join(resolvedDir, entry.name);
      const entryStat = fs.lstatSync(absEntry);

      if (entryStat.isSymbolicLink()) {
        const realEntry = resolvePathWithinRoot(absRoot, absEntry);
        const realStat = fs.statSync(realEntry);
        if (realStat.isDirectory()) {
          walk(realEntry);
          continue;
        }
        if (realStat.isFile() && hasPdfExtension(realEntry)) {
          files.push(realEntry);
        }
        continue;
      }

      if (entryStat.isDirectory()) {
        walk(absEntry);
        continue;
      }

      if (entryStat.isFile() && hasPdfExtension(absEntry)) {
        files.push(absEntry);
      }
    }
  };

  if (stat.isSymbolicLink()) {
    const realTarget = resolvePathWithinRoot(absRoot, absTarget);
    const realStat = fs.statSync(realTarget);
    if (realStat.isDirectory()) {
      walk(realTarget);
    } else if (realStat.isFile() && hasPdfExtension(realTarget)) {
      files.push(realTarget);
    }
  } else if (stat.isFile()) {
    if (hasPdfExtension(absTarget)) {
      files.push(absTarget);
    }
  } else if (stat.isDirectory()) {
    walk(absTarget);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function ingestPdf(targetPath, options = {}) {
  const files = listPdfFiles(targetPath, options);
  const entries = [];
  const errors = [];
  for (const filePath of files) {
    const buffer = fs.readFileSync(filePath);
    try {
      entries.push(...await parsePdf(buffer, filePath));
    } catch (e) {
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
  const learned = [];
  for (const entry of result.entries) {
    const provenance = {
      provenanceId: `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'pdf-adapter',
      sourceRef: entry.sourceRef,
      sourceType: 'document',
      sourceSubType: 'pdf',
      contentHash: contentHash(entry.content),
      contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
      actor: options.actor || 'pdf-adapter',
      timestamp: new Date().toISOString(),
    };
    try {
      const r = kernel.learn(entry.content, { provenance, sourceType: 'document', sourceSubType: 'pdf', sourceRef: provenance.sourceRef });
      learned.push({ entryKey: entry.entryKey, learned: r.data.learned, ok: true });
    } catch (e) {
      learned.push({ entryKey: entry.entryKey, error: e.message, ok: false });
    }
  }
  return { ...result, learned };
}

module.exports = {
  parsePdf,
  listPdfFiles,
  ingestPdf,
  ingestAndLearn,
  hasPdfExtension,
};
