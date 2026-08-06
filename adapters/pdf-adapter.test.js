const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parsePdf, listPdfFiles, ingestPdf, ingestAndLearn } = require('./pdf-adapter');

/**
 * Builds a minimal, valid-enough PDF with one page per string in `pageTexts`.
 * pdf.js recovers from an approximate/absent xref table by scanning the file
 * for objects (as it does here), so this favors simplicity over a
 * byte-perfect xref -- it is a test fixture, not a spec-compliant writer.
 */
function makeMinimalPdf(pageTexts) {
  const n = pageTexts.length;
  const pageObjNums = Array.from({ length: n }, (_, i) => 3 + i);
  const fontObjNum = 3 + n;
  const contentObjNums = Array.from({ length: n }, (_, i) => 4 + n + i);

  const objects = [];
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((p) => `${p} 0 R`).join(' ')}] /Count ${n} >>\nendobj`);

  pageTexts.forEach((_, i) => {
    objects.push(
      `${pageObjNums[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> `
      + `/MediaBox [0 0 300 144] /Contents ${contentObjNums[i]} 0 R >>\nendobj`
    );
  });

  objects.push(`${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`);

  pageTexts.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 20 100 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`;
    objects.push(`${contentObjNums[i]} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`);
  });

  const body = objects.join('\n');
  return `%PDF-1.4\n${body}\ntrailer\n<< /Size ${4 + 2 * n} /Root 1 0 R >>\nstartxref\n0\n%%EOF`;
}

function writeFixture(dir, name, pageTexts) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, makeMinimalPdf(pageTexts), 'latin1');
  return filePath;
}

test('pdf-adapter: parsePdf extracts text per non-empty page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pdf-'));
  try {
    const file = writeFixture(dir, 'two-page.pdf', ['Hello PDF World', 'Second page text']);
    const buffer = fs.readFileSync(file);
    const entries = await parsePdf(buffer, file);

    assert.equal(entries.length, 2);
    assert.equal(entries[0].entryKey, 'page-1');
    assert.equal(entries[0].content, 'Hello PDF World');
    assert.equal(entries[1].entryKey, 'page-2');
    assert.equal(entries[1].content, 'Second page text');
    assert.ok(entries.every((e) => typeof e.sourceRef === 'string' && e.sourceRef.includes('page-')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pdf-adapter: parsePdf rejects a non-PDF buffer', async () => {
  await assert.rejects(() => parsePdf(Buffer.from('not a pdf at all'), '/tmp/broken.pdf'));
});

test('pdf-adapter: listPdfFiles and ingestPdf work recursively', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pdf-list-'));
  const nested = path.join(dir, 'docs');
  fs.mkdirSync(nested, { recursive: true });
  writeFixture(dir, 'root.pdf', ['Root page']);
  writeFixture(nested, 'sub.pdf', ['Sub page']);
  fs.writeFileSync(path.join(nested, 'ignore.txt'), 'not pdf', 'utf8');

  try {
    const files = listPdfFiles(dir, { rootPath: dir });
    const result = await ingestPdf(dir, { rootPath: dir });

    assert.equal(files.length, 2);
    assert.equal(result.files.length, 2);
    assert.equal(result.entries.length, 2);
    assert.equal(result.errors.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pdf-adapter: ingestPdf reports parse errors without throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pdf-err-'));
  const bad = path.join(dir, 'broken.pdf');
  fs.writeFileSync(bad, 'not a real pdf', 'utf8');

  try {
    const result = await ingestPdf(dir, { rootPath: dir });
    assert.equal(result.entries.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].filePath, bad);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pdf-adapter: rejects traversal and absolute paths outside root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pdf-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pdf-outside-'));
  writeFixture(dir, 'inside.pdf', ['safe']);
  writeFixture(outsideDir, 'outside.pdf', ['secret']);

  try {
    assert.deepEqual(
      listPdfFiles(path.join(dir, 'inside.pdf'), { rootPath: dir }),
      [path.resolve(dir, 'inside.pdf')]
    );
    assert.throws(
      () => listPdfFiles(path.join(dir, '..', path.basename(outsideDir), 'outside.pdf'), { rootPath: dir }),
      /allowed root/i
    );
    assert.throws(
      () => listPdfFiles(path.join(outsideDir, 'outside.pdf'), { rootPath: dir }),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('pdf-adapter: rejects symlink escape when supported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pdf-link-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pdf-link-out-'));
  const outside = writeFixture(outsideDir, 'escape.pdf', ['secret']);
  const linkPath = path.join(dir, 'escape.pdf');

  try {
    try {
      fs.symlinkSync(outside, linkPath);
    } catch (err) {
      return;
    }
    assert.throws(
      () => listPdfFiles(linkPath, { rootPath: dir }),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('pdf-adapter: ingestAndLearn forwards provenance per page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pdf-learn-'));
  const calls = [];
  writeFixture(dir, 'note.pdf', ['A bounded claim']);
  const file = path.join(dir, 'note.pdf');

  try {
    const result = await ingestAndLearn(file, {
      learn(text, opts) {
        calls.push({ text, opts });
        return {
          data: { learned: 1 },
          receipt: { receiptId: 'delegated-receipt' },
        };
      },
    }, {
      rootPath: dir,
      actor: 'pdf-test',
    });

    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0].ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.sourceType, 'pdf');
    assert.equal(calls[0].opts.provenance.source, 'pdf-adapter');
    assert.equal(calls[0].opts.provenance.actor, 'pdf-test');
    assert.match(calls[0].opts.provenance.provenanceId, /^pdf-\d+-[a-z0-9]{6}$/);
    assert.equal(calls[0].opts.provenance.sourceRef, calls[0].opts.sourceRef);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
