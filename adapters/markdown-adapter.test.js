const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseMarkdown, listMarkdownFiles, ingestMarkdown, ingestAndLearn } = require('./markdown-adapter');

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

  const files = listMarkdownFiles(dir, { rootPath: dir });
  const result = ingestMarkdown(dir, { rootPath: dir });

  try {
    assert.equal(files.length, 2);
    assert.equal(result.files.length, 2);
    assert.equal(result.sections.length >= 2, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markdown-adapter: rejects traversal and absolute paths outside root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-md-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-md-outside-'));
  const inside = path.join(dir, 'inside.md');
  const outside = path.join(outsideDir, 'outside.md');
  fs.writeFileSync(inside, '# Inside\nsafe text', 'utf8');
  fs.writeFileSync(outside, '# Outside\nsecret text', 'utf8');

  try {
    assert.deepEqual(listMarkdownFiles(inside, { rootPath: dir }), [path.resolve(inside)]);
    assert.throws(
      () => listMarkdownFiles(path.join(dir, '..', path.basename(outside)), { rootPath: dir }),
      /allowed root/i
    );
    assert.throws(
      () => listMarkdownFiles(outside, { rootPath: dir }),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('markdown-adapter: rejects symlink escape when supported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-md-link-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-md-link-out-'));
  const outside = path.join(outsideDir, 'escape.md');
  const linkPath = path.join(dir, 'escape.md');
  fs.writeFileSync(outside, '# Outside\nsecret text', 'utf8');

  try {
    try {
      fs.symlinkSync(outside, linkPath);
    } catch (err) {
      return;
    }
    assert.throws(
      () => listMarkdownFiles(linkPath, { rootPath: dir }),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('markdown-adapter: ingestAndLearn forwards structural volatile provenance without connector evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-md-learn-'));
  const file = path.join(dir, 'note.md');
  const calls = [];
  fs.writeFileSync(file, '# Claim\nA bounded claim', 'utf8');

  try {
    const result = ingestAndLearn(file, {
      learn(text, opts) {
        calls.push({ text, opts });
        return {
          data: { learned: 1 },
          receipt: { receiptId: 'delegated-receipt' },
        };
      },
    }, {
      rootPath: dir,
      actor: 'markdown-test',
    });

    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0].ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.sourceType, 'document');
    assert.equal(calls[0].opts.sourceSubType, 'markdown');
    assert.equal(calls[0].opts.provenance.source, 'markdown-adapter');
    assert.equal(calls[0].opts.provenance.sourceType, 'document');
    assert.equal(calls[0].opts.provenance.sourceSubType, 'markdown');
    assert.equal(calls[0].opts.provenance.actor, 'markdown-test');
    assert.match(calls[0].opts.provenance.provenanceId, /^markdown-\d+-[a-z0-9]{6}$/);
    assert.match(calls[0].opts.provenance.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(calls[0].opts.provenance.sourceRef, calls[0].opts.sourceRef);
    assert.equal(Object.hasOwn(calls[0].opts, 'mutationOperationId'), false);
    assert.equal(Object.hasOwn(result, 'receiptId'), false);
    assert.equal(Object.hasOwn(result, 'receipt'), false);
    assert.equal(Object.hasOwn(result.learned[0], 'receipt'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
