const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseMarkdown, listMarkdownFiles, ingestMarkdown } = require('./markdown-adapter');

test('markdown-adapter: parseMarkdown splits by headings', () => {
  const sections = parseMarkdown(
    '# Title\nA line\n## Scope\nB line\n### Details\nC line',
    'C:/tmp/spec.md'
  );

  assert.equal(sections.length, 3);
  assert.equal(sections[0].sectionTitle, 'Title');
  assert.equal(sections[1].sectionTitle, 'Scope');
  assert.equal(sections[2].sectionTitle, 'Details');
  assert.equal(sections.every(item => typeof item.sourceRef === 'string'), true);
});

test('markdown-adapter: listMarkdownFiles and ingestMarkdown work recursively', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-md-'));
  const nested = path.join(dir, 'docs');
  fs.mkdirSync(nested, { recursive: true });
  const f1 = path.join(dir, 'README.md');
  const f2 = path.join(nested, 'guide.md');
  const f3 = path.join(nested, 'ignore.txt');
  fs.writeFileSync(f1, '# Root\nroot text', 'utf8');
  fs.writeFileSync(f2, '# Guide\nguide text', 'utf8');
  fs.writeFileSync(f3, 'not markdown', 'utf8');

  const files = listMarkdownFiles(dir);
  const result = ingestMarkdown(dir);

  try {
    assert.equal(files.length, 2);
    assert.equal(result.files.length, 2);
    assert.equal(result.sections.length >= 2, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
