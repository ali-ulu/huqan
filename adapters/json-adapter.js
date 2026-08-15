const { contentHash, CONTENT_HASH_ALGORITHM } = require('../lib/content-hash');
const fs = require('fs');
const path = require('path');
const { listFilesWithinRoot } = require('../lib/safe-file-walk');

function toAbs(p) {
  return path.resolve(String(p || ''));
}

const ALLOWED_JSON_EXTENSIONS = new Set(['.json']);
const JSON_LIMITS = Object.freeze({ maxFiles: 1_000, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024, maxEntriesPerFile: 5_000, maxTotalEntries: 10_000, maxValueDepth: 64, maxValueNodes: 100_000, maxOutputBytesPerEntry: 256 * 1024, maxOutputBytesPerFile: 2 * 1024 * 1024, maxTotalOutputBytes: 10 * 1024 * 1024 });

function jsonError(code, message, details = {}) { const error = new Error(message); error.code = code; Object.assign(error, details); return error; }
function jsonLimits(options = {}) {
  const limits = {};
  for (const [name, fallback] of Object.entries(JSON_LIMITS)) {
    const value = options[name] === undefined ? fallback : options[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw jsonError('JSON_INVALID_LIMIT', `${name} must be a positive safe integer`);
    limits[name] = value;
  }
  return limits;
}
function inspectJsonValue(value, limits, state, depth = 0) {
  if (depth > limits.maxValueDepth) throw jsonError('JSON_VALUE_DEPTH_LIMIT', 'JSON value depth limit exceeded');
  if (value === null || typeof value !== 'object') return;
  state.nodes += 1;
  if (state.nodes > limits.maxValueNodes) throw jsonError('JSON_VALUE_NODE_LIMIT', 'JSON value node limit exceeded');
  for (const child of (Array.isArray(value) ? value : Object.values(value))) inspectJsonValue(child, limits, state, depth + 1);
}

function hasJsonExtension(filePath) {
  return ALLOWED_JSON_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Splits a parsed JSON document into flat, learnable entries. The root
 * object's top-level keys become entries (arrays use their index as the
 * key); a non-object root is a single 'root' entry. This mirrors
 * markdown-adapter's heading-based sections so both adapters feed
 * kernel.learn the same shape of input.
 */
function parseJson(content, filePath = '', options = {}) {
  const limits = jsonLimits(options);
  const absPath = toAbs(filePath || '.');
  const source = String(content ?? '');
  const inputBytes = Buffer.byteLength(source, 'utf8');
  if (inputBytes > limits.maxFileBytes) throw jsonError('JSON_FILE_BYTES_LIMIT', 'JSON file byte limit exceeded');
  const parsed = JSON.parse(source);
  inspectJsonValue(parsed, limits, { nodes: 0 });
  const entries = [];
  let outputBytes = 0;

  const pushEntry = (entryKey, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text || !text.trim()) return;
    if (entries.length >= limits.maxEntriesPerFile) throw jsonError('JSON_ENTRY_LIMIT', 'JSON entry limit exceeded');
    const trimmed = text.trim();
    const bytes = Buffer.byteLength(trimmed, 'utf8');
    if (bytes > limits.maxOutputBytesPerEntry) throw jsonError('JSON_ENTRY_OUTPUT_BYTES_LIMIT', 'JSON entry output byte limit exceeded');
    outputBytes += bytes;
    if (outputBytes > limits.maxOutputBytesPerFile) throw jsonError('JSON_OUTPUT_BYTES_LIMIT', 'JSON file output byte limit exceeded');
    entries.push({
      entryKey,
      filePath: absPath,
      content: trimmed,
      sourceRef: `file:${absPath}:${entryKey}`,
    });
  };

  if (Array.isArray(parsed)) {
    parsed.forEach((value, index) => pushEntry(`[${index}]`, value));
  } else if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) {
      pushEntry(key, value);
    }
  } else {
    pushEntry('root', parsed);
  }

  return entries;
}

function listJsonFiles(targetPath, options = {}) {
  return listFilesWithinRoot(targetPath, { ...options, matchesFile: hasJsonExtension });
}

function ingestJson(targetPath, options = {}) {
  const limits = jsonLimits(options);
  const files = listJsonFiles(targetPath, options);
  if (files.length > limits.maxFiles) throw jsonError('JSON_FILE_COUNT_LIMIT', 'JSON file count limit exceeded');
  let totalBytes = 0;
  for (const filePath of files) {
    const bytes = fs.statSync(filePath).size;
    if (bytes > limits.maxFileBytes) throw jsonError('JSON_FILE_BYTES_LIMIT', 'JSON file byte limit exceeded', { filePath });
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) throw jsonError('JSON_TOTAL_BYTES_LIMIT', 'JSON aggregate byte limit exceeded');
  }
  const entries = [];
  const errors = [];
  let totalOutputBytes = 0;
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    try {
      const parsed = parseJson(content, filePath, limits);
      if (entries.length + parsed.length > limits.maxTotalEntries) throw jsonError('JSON_TOTAL_ENTRY_LIMIT', 'JSON aggregate entry limit exceeded');
      totalOutputBytes += parsed.reduce((sum, entry) => sum + Buffer.byteLength(entry.content, 'utf8'), 0);
      if (totalOutputBytes > limits.maxTotalOutputBytes) throw jsonError('JSON_TOTAL_OUTPUT_BYTES_LIMIT', 'JSON aggregate output byte limit exceeded');
      entries.push(...parsed);
    } catch (e) {
      if (typeof e?.code === 'string' && e.code.startsWith('JSON_')) throw e;
      errors.push({ filePath, error: e.message });
    }
  }
  return {
    files,
    entries,
    errors,
  };
}

function ingestAndLearn(targetPath, kernel, options = {}) {
  const result = ingestJson(targetPath, options);
  const learned = [];
  for (const entry of result.entries) {
    const provenance = {
      provenanceId: `json-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'json-adapter',
      sourceRef: entry.sourceRef,
      sourceType: 'document',
      sourceSubType: 'json',
      contentHash: contentHash(entry.content),
      contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
      actor: options.actor || 'json-adapter',
      timestamp: new Date().toISOString(),
    };
    try {
      const r = kernel.learn(entry.content, { provenance, sourceType: 'document', sourceSubType: 'json', sourceRef: provenance.sourceRef });
      learned.push({ entryKey: entry.entryKey, learned: r.data.learned, ok: true });
    } catch (e) {
      learned.push({ entryKey: entry.entryKey, error: e.message, ok: false });
    }
  }
  return { ...result, learned };
}

module.exports = {
  JSON_LIMITS,
  parseJson,
  listJsonFiles,
  ingestJson,
  ingestAndLearn,
  hasJsonExtension,
};
