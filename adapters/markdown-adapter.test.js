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

test('markdown-adapter: fenced code comments remain content under their real heading', () => {
  const sections = parseMarkdown([
    '# Real Heading',
    '',
    'Some real prose about the policy.',
    '',
    '```bash',
    '# rm -rf / --no-preserve-root',
    'echo danger',
    '```',
    '',
    'More prose belonging to Real Heading.',
  ].join('\n'), '/tmp/fenced.md');

  assert.equal(sections.length, 1);
  assert.equal(sections[0].sectionTitle, 'Real Heading');
  assert.match(sections[0].content, /# rm -rf \/ --no-preserve-root/);
  assert.match(sections[0].content, /More prose belonging to Real Heading\./);
  assert.match(sections[0].sourceRef, /:Real Heading$/);
});

test('markdown-adapter: bounds lines, sections, and section output', () => {
  assert.throws(
    () => parseMarkdown('one\ntwo\nthree', '/tmp/lines.md', { maxLinesPerFile: 2 }),
    (error) => error?.code === 'MARKDOWN_LINE_LIMIT',
  );
  assert.throws(
    () => parseMarkdown('# A\na\n# B\nb', '/tmp/sections.md', { maxSectionsPerFile: 1 }),
    (error) => error?.code === 'MARKDOWN_SECTION_LIMIT',
  );
  assert.throws(
    () => parseMarkdown('# A\ntoo-long', '/tmp/output.md', { maxOutputBytesPerSection: 4 }),
    (error) => error?.code === 'MARKDOWN_SECTION_OUTPUT_BYTES_LIMIT',
  );
});

test('markdown-adapter: aggregate budget failure is atomic before learning', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-markdown-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.md'), '# A\nalpha');
  fs.writeFileSync(path.join(dir, 'b.md'), '# B\nbeta');
  let calls = 0;
  assert.throws(
    () => ingestAndLearn(dir, { learn() { calls += 1; } }, { rootPath: dir, maxTotalOutputBytes: 8 }),
    (error) => error?.code === 'MARKDOWN_TOTAL_OUTPUT_BYTES_LIMIT',
  );
  assert.equal(calls, 0);
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
