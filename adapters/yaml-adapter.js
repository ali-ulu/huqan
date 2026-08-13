const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { resolvePathWithinRoot } = require('../lib/path-safety');

function toAbs(p) {
  return path.resolve(String(p || ''));
}

const ALLOWED_YAML_EXTENSIONS = new Set(['.yaml', '.yml']);

function hasYamlExtension(filePath) {
  return ALLOWED_YAML_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Splits a parsed YAML document into flat, learnable entries. Same shape as
 * json-adapter's parseJson: the root object's top-level keys become entries
 * (arrays use their index as the key); a non-object root is a single 'root'
 * entry. js-yaml's default schema (DEFAULT_SCHEMA, no !!js/* tags) is used,
 * so parsing never executes code or constructs arbitrary JS types.
 */
function parseYaml(content, filePath = '') {
  const absPath = toAbs(filePath || '.');
  const parsed = yaml.load(String(content ?? ''));
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
  } else if (parsed !== undefined && parsed !== null) {
    pushEntry('root', parsed);
  }

  return entries;
}

function listYamlFiles(targetPath, options = {}) {
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
        if (realStat.isFile() && hasYamlExtension(realEntry)) {
          files.push(realEntry);
        }
        continue;
      }

      if (entryStat.isDirectory()) {
        walk(absEntry);
        continue;
      }

      if (entryStat.isFile() && hasYamlExtension(absEntry)) {
        files.push(absEntry);
      }
    }
  };

  if (stat.isSymbolicLink()) {
    const realTarget = resolvePathWithinRoot(absRoot, absTarget);
    const realStat = fs.statSync(realTarget);
    if (realStat.isDirectory()) {
      walk(realTarget);
    } else if (realStat.isFile() && hasYamlExtension(realTarget)) {
      files.push(realTarget);
    }
  } else if (stat.isFile()) {
    if (hasYamlExtension(absTarget)) {
      files.push(absTarget);
    }
  } else if (stat.isDirectory()) {
    walk(absTarget);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function ingestYaml(targetPath, options = {}) {
  const files = listYamlFiles(targetPath, options);
  const entries = [];
  const errors = [];
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    try {
      entries.push(...parseYaml(content, filePath));
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
  const result = ingestYaml(targetPath, options);
  const learned = [];
  for (const entry of result.entries) {
    const provenance = {
      provenanceId: `yaml-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'yaml-adapter',
      sourceRef: entry.sourceRef,
      sourceType: 'document',
      sourceSubType: 'yaml',
      actor: options.actor || 'yaml-adapter',
      timestamp: new Date().toISOString(),
    };
    try {
      const r = kernel.learn(entry.content, { provenance, sourceType: 'document', sourceSubType: 'yaml', sourceRef: provenance.sourceRef });
      learned.push({ entryKey: entry.entryKey, learned: r.data.learned, ok: true });
    } catch (e) {
      learned.push({ entryKey: entry.entryKey, error: e.message, ok: false });
    }
  }
  return { ...result, learned };
}

module.exports = {
  parseYaml,
  listYamlFiles,
  ingestYaml,
  ingestAndLearn,
  hasYamlExtension,
};
