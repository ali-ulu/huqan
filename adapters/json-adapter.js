const { contentHash, CONTENT_HASH_ALGORITHM } = require('../lib/content-hash');
const fs = require('fs');
const path = require('path');
const { resolvePathWithinRoot } = require('../lib/path-safety');

function toAbs(p) {
  return path.resolve(String(p || ''));
}

const ALLOWED_JSON_EXTENSIONS = new Set(['.json']);

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
function parseJson(content, filePath = '') {
  const absPath = toAbs(filePath || '.');
  const parsed = JSON.parse(String(content ?? ''));
  const entries = [];

  const pushEntry = (entryKey, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text || !text.trim()) return;
    entries.push({
      entryKey,
      filePath: absPath,
      content: text.trim(),
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
        if (realStat.isFile() && hasJsonExtension(realEntry)) {
          files.push(realEntry);
        }
        continue;
      }

      if (entryStat.isDirectory()) {
        walk(absEntry);
        continue;
      }

      if (entryStat.isFile() && hasJsonExtension(absEntry)) {
        files.push(absEntry);
      }
    }
  };

  if (stat.isSymbolicLink()) {
    const realTarget = resolvePathWithinRoot(absRoot, absTarget);
    const realStat = fs.statSync(realTarget);
    if (realStat.isDirectory()) {
      walk(realTarget);
    } else if (realStat.isFile() && hasJsonExtension(realTarget)) {
      files.push(realTarget);
    }
  } else if (stat.isFile()) {
    if (hasJsonExtension(absTarget)) {
      files.push(absTarget);
    }
  } else if (stat.isDirectory()) {
    walk(absTarget);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function ingestJson(targetPath, options = {}) {
  const files = listJsonFiles(targetPath, options);
  const entries = [];
  const errors = [];
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    try {
      entries.push(...parseJson(content, filePath));
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
  parseJson,
  listJsonFiles,
  ingestJson,
  ingestAndLearn,
  hasJsonExtension,
};
