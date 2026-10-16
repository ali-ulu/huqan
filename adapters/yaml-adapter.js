const { contentHash, CONTENT_HASH_ALGORITHM } = require('../lib/content-hash');
const { learnEntriesSync } = require('./utils/learn-entries');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { listFilesWithinRoot } = require('../lib/safe-file-walk');

function toAbs(p) {
  return path.resolve(String(p || ''));
}

const ALLOWED_YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
const YAML_LIMITS = Object.freeze({
  maxFiles: 1_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
  maxEntriesPerFile: 5_000,
  maxTotalEntries: 10_000,
  maxValueDepth: 64,
  maxValueNodes: 100_000,
  maxOutputBytesPerEntry: 256 * 1024,
  maxOutputBytesPerFile: 2 * 1024 * 1024,
  maxTotalOutputBytes: 10 * 1024 * 1024,
});

function hasYamlExtension(filePath) {
  return ALLOWED_YAML_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function yamlError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function yamlLimits(options = {}) {
  const limits = {};
  for (const [name, fallback] of Object.entries(YAML_LIMITS)) {
    const value = options[name] === undefined ? fallback : options[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw yamlError('YAML_INVALID_LIMIT', `${name} must be a positive safe integer`);
    }
    limits[name] = value;
  }
  return limits;
}

function inspectYamlValue(value, limits, state, depth = 0) {
  if (depth > limits.maxValueDepth) {
    throw yamlError('YAML_VALUE_DEPTH_LIMIT', 'YAML value depth limit exceeded', {
      limit: limits.maxValueDepth,
    });
  }
  if (value === null || typeof value !== 'object') return;
  if (state.seen.has(value)) {
    throw yamlError('YAML_ALIAS_FORBIDDEN', 'YAML aliases and repeated object references are not allowed');
  }
  state.seen.add(value);
  state.nodes += 1;
  if (state.nodes > limits.maxValueNodes) {
    throw yamlError('YAML_VALUE_NODE_LIMIT', 'YAML value node limit exceeded', {
      limit: limits.maxValueNodes,
    });
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectYamlValue(item, limits, state, depth + 1);
  } else {
    for (const item of Object.values(value)) inspectYamlValue(item, limits, state, depth + 1);
  }
}

/**
 * Splits a parsed YAML document into flat, learnable entries. Same shape as
 * json-adapter's parseJson: the root object's top-level keys become entries
 * (arrays use their index as the key); a non-object root is a single 'root'
 * entry. js-yaml's default schema (DEFAULT_SCHEMA, no !!js/* tags) is used,
 * so parsing never executes code or constructs arbitrary JS types.
 */
function parseYaml(content, filePath = '', options = {}) {
  const limits = yamlLimits(options);
  const absPath = toAbs(filePath || '.');
  const source = String(content ?? '');
  const inputBytes = Buffer.byteLength(source, 'utf8');
  if (inputBytes > limits.maxFileBytes) {
    throw yamlError('YAML_FILE_BYTES_LIMIT', 'YAML file byte limit exceeded', {
      filePath: absPath,
      limit: limits.maxFileBytes,
      actual: inputBytes,
    });
  }
  const parsed = yaml.load(source);
  const state = { nodes: 0, seen: new WeakSet() };
  inspectYamlValue(parsed, limits, state);
  const entries = [];
  let outputBytes = 0;

  const pushEntry = (entryKey, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text || !text.trim()) return;
    if (entries.length >= limits.maxEntriesPerFile) {
      throw yamlError('YAML_ENTRY_LIMIT', 'YAML entry limit exceeded', {
        filePath: absPath,
        limit: limits.maxEntriesPerFile,
      });
    }
    const trimmed = text.trim();
    const entryBytes = Buffer.byteLength(trimmed, 'utf8');
    if (entryBytes > limits.maxOutputBytesPerEntry) {
      throw yamlError('YAML_ENTRY_OUTPUT_BYTES_LIMIT', 'YAML entry output byte limit exceeded', {
        filePath: absPath,
        entryKey,
        limit: limits.maxOutputBytesPerEntry,
        actual: entryBytes,
      });
    }
    outputBytes += entryBytes;
    if (outputBytes > limits.maxOutputBytesPerFile) {
      throw yamlError('YAML_OUTPUT_BYTES_LIMIT', 'YAML file output byte limit exceeded', {
        filePath: absPath,
        limit: limits.maxOutputBytesPerFile,
        actual: outputBytes,
      });
    }
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
  } else if (parsed !== undefined && parsed !== null) {
    pushEntry('root', parsed);
  }

  return entries;
}

function listYamlFiles(targetPath, options = {}) {
  return listFilesWithinRoot(targetPath, { ...options, matchesFile: hasYamlExtension });
}

function ingestYaml(targetPath, options = {}) {
  const limits = yamlLimits(options);
  const files = listYamlFiles(targetPath, options);
  if (files.length > limits.maxFiles) {
    throw yamlError('YAML_FILE_COUNT_LIMIT', 'YAML file count limit exceeded', {
      limit: limits.maxFiles,
      actual: files.length,
    });
  }

  let totalBytes = 0;
  for (const filePath of files) {
    const bytes = fs.statSync(filePath).size;
    if (bytes > limits.maxFileBytes) {
      throw yamlError('YAML_FILE_BYTES_LIMIT', 'YAML file byte limit exceeded', {
        filePath,
        limit: limits.maxFileBytes,
        actual: bytes,
      });
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw yamlError('YAML_TOTAL_BYTES_LIMIT', 'YAML aggregate byte limit exceeded', {
        limit: limits.maxTotalBytes,
        actual: totalBytes,
      });
    }
  }

  const entries = [];
  const errors = [];
  let totalOutputBytes = 0;
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    try {
      const parsed = parseYaml(content, filePath, limits);
      if (entries.length + parsed.length > limits.maxTotalEntries) {
        throw yamlError('YAML_TOTAL_ENTRY_LIMIT', 'YAML aggregate entry limit exceeded', {
          limit: limits.maxTotalEntries,
          actual: entries.length + parsed.length,
        });
      }
      totalOutputBytes += parsed.reduce(
        (sum, entry) => sum + Buffer.byteLength(entry.content, 'utf8'),
        0,
      );
      if (totalOutputBytes > limits.maxTotalOutputBytes) {
        throw yamlError('YAML_TOTAL_OUTPUT_BYTES_LIMIT', 'YAML aggregate output byte limit exceeded', {
          limit: limits.maxTotalOutputBytes,
          actual: totalOutputBytes,
        });
      }
      entries.push(...parsed);
    } catch (e) {
      if (typeof e?.code === 'string' && e.code.startsWith('YAML_')) throw e;
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
  const result = ingestYaml(targetPath, options);
  return learnEntriesSync(result, kernel, options, 'document', 'yaml');
}

module.exports = {
  YAML_LIMITS,
  parseYaml,
  listYamlFiles,
  ingestYaml,
  ingestAndLearn,
  hasYamlExtension,
};
