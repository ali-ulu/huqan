const fs = require('fs');
const path = require('path');

function toAbs(p) {
  return path.resolve(String(p || ''));
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

function listMarkdownFiles(targetPath) {
  const absTarget = toAbs(targetPath);
  if (!fs.existsSync(absTarget)) return [];

  const stat = fs.statSync(absTarget);
  if (stat.isFile()) {
    return absTarget.toLowerCase().endsWith('.md') ? [absTarget] : [];
  }

  const files = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absEntry = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absEntry);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(absEntry);
      }
    }
  };

  walk(absTarget);
  return files;
}

function ingestMarkdown(targetPath) {
  const files = listMarkdownFiles(targetPath);
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

module.exports = {
  parseMarkdown,
  listMarkdownFiles,
  ingestMarkdown,
};
