const fs = require('fs');
const path = require('path');
const { resolvePathWithinRoot } = require('../lib/path-safety');

function toAbs(p) {
  return path.resolve(String(p || ''));
}

const ALLOWED_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

function hasMarkdownExtension(filePath) {
  return ALLOWED_MARKDOWN_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function parseMarkdown(content, filePath = '') {
  const absPath = toAbs(filePath || '.');
  const lines = String(content || '').split(/\r?\n/);
  const sections = [];

  let current = {
    sectionTitle: 'root',
    level: 0,
    filePath: absPath,
    content: '',
  };

  const flush = () => {
    const text = String(current.content || '').trim();
    if (!text) return;
    sections.push({
      sectionTitle: current.sectionTitle,
      level: current.level,
      filePath: absPath,
      content: text,
      sourceRef: `file:${absPath}:${current.sectionTitle}`,
    });
  };

  for (const line of lines) {
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
        if (realStat.isFile() && hasMarkdownExtension(realEntry)) {
          files.push(realEntry);
        }
        continue;
      }

      if (entryStat.isDirectory()) {
        walk(absEntry);
        continue;
      }

      if (entryStat.isFile() && hasMarkdownExtension(absEntry)) {
        files.push(absEntry);
      }
    }
  };

  if (stat.isSymbolicLink()) {
    const realTarget = resolvePathWithinRoot(absRoot, absTarget);
    const realStat = fs.statSync(realTarget);
    if (realStat.isDirectory()) {
      walk(realTarget);
    } else if (realStat.isFile() && hasMarkdownExtension(realTarget)) {
      files.push(realTarget);
    }
  } else if (stat.isFile()) {
    if (hasMarkdownExtension(absTarget)) {
      files.push(absTarget);
    }
  } else if (stat.isDirectory()) {
    walk(absTarget);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function ingestMarkdown(targetPath, options = {}) {
  const files = listMarkdownFiles(targetPath, options);
  const sections = [];
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    sections.push(...parseMarkdown(content, filePath));
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
      sourceType: 'markdown',
      actor: options.actor || 'markdown-adapter',
      timestamp: new Date().toISOString(),
    };
    try {
      const r = kernel.learn(section.content, { provenance, sourceType: 'markdown', sourceRef: provenance.sourceRef });
      learned.push({ section: section.sectionTitle, learned: r.data.learned, ok: true });
    } catch (e) {
      learned.push({ section: section.sectionTitle, error: e.message, ok: false });
    }
  }
  return { ...result, learned };
}

module.exports = {
  parseMarkdown,
  listMarkdownFiles,
  ingestMarkdown,
  ingestAndLearn,
  hasMarkdownExtension,
};
