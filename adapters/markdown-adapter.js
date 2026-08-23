const { contentHash, CONTENT_HASH_ALGORITHM } = require('../lib/content-hash');
const fs = require('fs');
const path = require('path');
const { listFilesWithinRoot } = require('../lib/safe-file-walk');

function toAbs(p) {
  return path.resolve(String(p || ''));
}

const ALLOWED_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const MARKDOWN_LIMITS = Object.freeze({ maxFiles: 1_000, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024, maxLinesPerFile: 100_000, maxSectionsPerFile: 5_000, maxTotalSections: 10_000, maxOutputBytesPerSection: 256 * 1024, maxOutputBytesPerFile: 2 * 1024 * 1024, maxTotalOutputBytes: 10 * 1024 * 1024 });

function markdownError(code, message, details = {}) { const error = new Error(message); error.code = code; Object.assign(error, details); return error; }
function markdownLimits(options = {}) {
  const limits = {};
  for (const [name, fallback] of Object.entries(MARKDOWN_LIMITS)) {
    const value = options[name] === undefined ? fallback : options[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw markdownError('MARKDOWN_INVALID_LIMIT', `${name} must be a positive safe integer`);
    limits[name] = value;
  }
  return limits;
}

function hasMarkdownExtension(filePath) {
  return ALLOWED_MARKDOWN_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function parseMarkdown(content, filePath = '', options = {}) {
  const limits = markdownLimits(options);
  const absPath = toAbs(filePath || '.');
  const source = String(content || '');
  if (Buffer.byteLength(source, 'utf8') > limits.maxFileBytes) throw markdownError('MARKDOWN_FILE_BYTES_LIMIT', 'Markdown file byte limit exceeded');
  const lines = source.split(/\r?\n/);
  if (lines.length > limits.maxLinesPerFile) throw markdownError('MARKDOWN_LINE_LIMIT', 'Markdown line limit exceeded');
  const sections = [];
  let outputBytes = 0;
  let fence = null;

  let current = {
    sectionTitle: 'root',
    level: 0,
    filePath: absPath,
    content: '',
  };

  const flush = () => {
    const text = String(current.content || '').trim();
    if (!text) return;
    if (sections.length >= limits.maxSectionsPerFile) throw markdownError('MARKDOWN_SECTION_LIMIT', 'Markdown section limit exceeded');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > limits.maxOutputBytesPerSection) throw markdownError('MARKDOWN_SECTION_OUTPUT_BYTES_LIMIT', 'Markdown section output byte limit exceeded');
    outputBytes += bytes;
    if (outputBytes > limits.maxOutputBytesPerFile) throw markdownError('MARKDOWN_OUTPUT_BYTES_LIMIT', 'Markdown file output byte limit exceeded');
    sections.push({
      sectionTitle: current.sectionTitle,
      level: current.level,
      filePath: absPath,
      content: text,
      sourceRef: `file:${absPath}:${current.sectionTitle}`,
    });
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fence) {
      current.content += `${line}\n`;
      if (trimmed.startsWith(fence.marker.repeat(fence.length))
          && /^\s*$/.test(trimmed.slice(fence.length))) fence = null;
      continue;
    }
    const openingFence = trimmed.match(/^(`{3,}|~{3,})/);
    if (openingFence) {
      fence = { marker: openingFence[1][0], length: openingFence[1].length };
      current.content += `${line}\n`;
      continue;
    }
    const headerMatch = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (headerMatch) {
      flush();
      current = {
        sectionTitle: headerMatch[2].trim(),
        level: headerMatch[1].length,
        filePath: absPath,
        content: '',
      };
      continue;
    }
    current.content += `${line}\n`;
  }

  flush();
  return sections;
}

function listMarkdownFiles(targetPath, options = {}) {
  return listFilesWithinRoot(targetPath, { ...options, matchesFile: hasMarkdownExtension });
}

function ingestMarkdown(targetPath, options = {}) {
  const limits = markdownLimits(options);
  const files = listMarkdownFiles(targetPath, options);
  if (files.length > limits.maxFiles) throw markdownError('MARKDOWN_FILE_COUNT_LIMIT', 'Markdown file count limit exceeded');
  let totalBytes = 0;
  for (const filePath of files) {
    const bytes = fs.statSync(filePath).size;
    if (bytes > limits.maxFileBytes) throw markdownError('MARKDOWN_FILE_BYTES_LIMIT', 'Markdown file byte limit exceeded', { filePath });
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) throw markdownError('MARKDOWN_TOTAL_BYTES_LIMIT', 'Markdown aggregate byte limit exceeded');
  }
  const sections = [];
  let totalOutputBytes = 0;
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseMarkdown(content, filePath, limits);
    if (sections.length + parsed.length > limits.maxTotalSections) throw markdownError('MARKDOWN_TOTAL_SECTION_LIMIT', 'Markdown aggregate section limit exceeded');
    totalOutputBytes += parsed.reduce((sum, section) => sum + Buffer.byteLength(section.content, 'utf8'), 0);
    if (totalOutputBytes > limits.maxTotalOutputBytes) throw markdownError('MARKDOWN_TOTAL_OUTPUT_BYTES_LIMIT', 'Markdown aggregate output byte limit exceeded');
    sections.push(...parsed);
  }
  return {
    files,
    sections,
  };
}

function ingestAndLearn(targetPath, kernel, options = {}) {
  const result = ingestMarkdown(targetPath, options);
  const learned = [];
  for (const section of result.sections) {
    const provenance = {
      provenanceId: `markdown-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      source: 'markdown-adapter',
      sourceRef: section.sourceRef,
      sourceType: 'document',
      sourceSubType: 'markdown',
      contentHash: contentHash(section.content),
      contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
      actor: options.actor || 'markdown-adapter',
      timestamp: new Date().toISOString(),
    };
    try {
      const r = kernel.learn(section.content, { provenance, sourceType: 'document', sourceSubType: 'markdown', sourceRef: provenance.sourceRef });
      learned.push({ section: section.sectionTitle, learned: r.data.learned, ok: true });
    } catch (e) {
      learned.push({ section: section.sectionTitle, error: e.message, ok: false });
    }
  }
  return { ...result, learned };
}

module.exports = {
  MARKDOWN_LIMITS,
  parseMarkdown,
  listMarkdownFiles,
  ingestMarkdown,
  ingestAndLearn,
  hasMarkdownExtension,
};
